// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import type { OpenShellTarget } from "./ClaudeOpenShellSpawn.ts";

const BASELINE_MESSAGE = "T3 baseline";
const SANDBOX_READ_MAX_BYTES = 1024 * 1024;

const quote = (value: string): string => `'${value.split("'").join("'\\''")}'`;

/** Staging lives on the Linux filesystem: uploads from /mnt/<drive> lose their content. */
const stagingRoot = (sandbox: string): string => `$HOME/.cache/t3-openshell/${sandbox}`;

const linuxCommand = (
  target: Pick<OpenShellTarget, "wslDistro">,
  script: string,
  platform: NodeJS.Platform,
) =>
  platform === "win32"
    ? {
        command: "wsl.exe",
        args: [
          ...(target.wslDistro === undefined ? [] : ["-d", target.wslDistro]),
          "--cd",
          "~",
          "-e",
          "sh",
          "-c",
          script,
        ],
      }
    : { command: "sh", args: ["-c", script] };

const run = (
  command: string,
  args: ReadonlyArray<string>,
  input?: Buffer,
  cwd?: string,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Array<Buffer> = [];
    const err: Array<Buffer> = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else
        reject(
          new Error(`${command} exited ${code}: ${Buffer.concat(err).toString().slice(-400)}`),
        );
    });
    child.stdin.end(input);
  });

export const runInLinux = (
  target: Pick<OpenShellTarget, "wslDistro">,
  script: string,
  platform: NodeJS.Platform,
  input?: Buffer,
): Promise<Buffer> => {
  const { command, args } = linuxCommand(target, script, platform);
  return run(command, args, input);
};

/** Docker Desktop adds its own distros, and they cannot host a sandbox. */
export const parseDistroList = (listing: Buffer): ReadonlyArray<string> =>
  listing
    .toString("utf16le")
    .split(/\r?\n/)
    .map((name) => name.split("\0").join("").trim())
    .filter((name) => name !== "" && !name.startsWith("docker-"));

/** A machine with no template yet still has to name a distro, or Docker's default may win. */
export const resolveHostDistro = async (
  configured: string | undefined,
  platform: NodeJS.Platform,
): Promise<string | undefined> => {
  if (configured !== undefined || platform !== "win32") return configured;
  return parseDistroList(await run("wsl.exe", ["-l", "-q"]).catch(() => Buffer.alloc(0)))[0];
};

const execInBox = (target: OpenShellTarget, script: string, platform: NodeJS.Platform) =>
  runInLinux(
    target,
    `exec openshell sandbox exec --name ${quote(target.sandbox)} --no-tty --timeout 0 --workdir ${quote(target.workdir)} -- sh -c ${quote(script)} </dev/null`,
    platform,
  );

const execInSandboxRoot = (target: OpenShellTarget, script: string, platform: NodeJS.Platform) =>
  execInBox({ ...target, workdir: NodePath.posix.dirname(target.workdir) }, script, platform);

const parseTrackedFiles = (listing: Buffer): ReadonlyArray<string> =>
  listing.toString("utf8").split("\0").filter(Boolean);

const SANDBOX_READY_ATTEMPTS = 90;

/** Sits above the workdir, so Claude reads it while it stays out of the project's diff. */
const SANDBOX_INSTRUCTIONS = `# Sandbox

You run inside an OpenShell sandbox. Your changes stay in this box, and the user decides whether they leave it.

Network access is denied by default. When a command fails because a host is unreachable, do not look for a workaround. Tell the user which host you need and why, then stop and wait. The blocked attempt already reached the user as an access request, and the rule is active as soon as they approve it.

You have no root access, so apt cannot install anything here. Install tools under $HOME/.local after the user approves the hosts you need.

When a path outside your limits is refused, the user sees a request to allow reading it. Approving restarts the box, so stop and let them answer. Write limits cannot be widened.
`;

const writeInstructionsScript = `cat > CLAUDE.md <<'T3_EOF'
${SANDBOX_INSTRUCTIONS}T3_EOF`;

const createCommand = (target: OpenShellTarget, policy: string | undefined) =>
  [
    `openshell sandbox create --name ${quote(target.sandbox)} --no-tty --detach --from "${target.image}"`,
    policy === undefined ? "" : `--policy "${policy}"`,
    target.provider === undefined ? "" : `--provider ${quote(target.provider)}`,
    "-- sleep infinity </dev/null >/dev/null",
  ].join(" ");

/** Creates the thread's box on first use. Later turns find it running and move on. */
export const ensureSandbox = (target: OpenShellTarget, platform: NodeJS.Platform) => {
  const name = quote(target.sandbox);
  const create = createCommand(target, target.policy);
  return runInLinux(
    target,
    `openshell sandbox get ${name} </dev/null >/dev/null 2>&1 || ${create}
if openshell sandbox list </dev/null | grep -q "^${target.sandbox} .*Stopped"; then
  openshell sandbox start ${name} </dev/null >/dev/null
fi
i=0
while [ "$i" -lt ${SANDBOX_READY_ATTEMPTS} ]; do
  openshell sandbox list </dev/null | grep -q "^${target.sandbox} .*Ready" && exit 0
  i=$((i + 1))
  sleep 2
done
echo "sandbox ${target.sandbox} did not become ready" >&2
exit 1`,
    platform,
  );
};

/**
 * A box keeps the image it started from, so a new image means a new box. Everything the chat owns
 * lives under /sandbox. The backup stays on disk if anything fails after the old box is gone.
 */
export const recreateSandbox = async (
  target: OpenShellTarget,
  policy: string,
  platform: NodeJS.Platform,
): Promise<void> => {
  const name = quote(target.sandbox);
  const folder = `$HOME/.cache/t3-openshell/update-${target.sandbox}`;
  const exec = `openshell sandbox exec --name ${name} --no-tty --timeout 0 --`;
  const archive = "/tmp/t3-restore.tar";
  await runInLinux(
    target,
    `set -eu
DIR="${folder}"
rm -rf "$DIR"
mkdir -p "$DIR"
cat >"$DIR/policy.json"
${exec} sh -c 'cd /sandbox && tar -cf - .' </dev/null >"$DIR/sandbox.tar"
tar -tf "$DIR/sandbox.tar" >"$DIR/entries"
[ -s "$DIR/entries" ] || { echo "The sandbox backup is empty, nothing was changed." >&2; exit 1; }
fail() { echo "Update stopped. The sandbox backup is in $DIR." >&2; exit 1; }
trap fail EXIT
openshell sandbox delete ${name} </dev/null >/dev/null
i=0
while openshell sandbox get ${name} </dev/null >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt ${SANDBOX_READY_ATTEMPTS} ] || exit 1
  sleep 1
done
${createCommand(target, "$DIR/policy.json")}
i=0
until openshell sandbox list </dev/null | grep -q "^${target.sandbox} .*Ready"; do
  i=$((i + 1))
  [ "$i" -lt ${SANDBOX_READY_ATTEMPTS} ] || exit 1
  sleep 2
done
openshell sandbox upload ${name} "$DIR/sandbox.tar" ${archive} </dev/null >/dev/null
${exec} sh -c 'tar -C /sandbox --no-overwrite-dir -xf ${archive} && rm -f ${archive}' </dev/null >/dev/null
trap - EXIT
rm -rf "$DIR"`,
    platform,
    Buffer.from(policy),
  );
  await execInSandboxRoot(target, writeInstructionsScript, platform);
};

/** Filesystem rules load only when the supervisor starts, so a new one needs this. */
export const restartSandbox = (target: OpenShellTarget, platform: NodeJS.Platform) => {
  const name = quote(target.sandbox);
  const waitFor = (phase: string) => `i=0
until openshell sandbox list </dev/null | grep -q "^${target.sandbox} .*${phase}"; do
  i=$((i + 1))
  [ "$i" -lt ${SANDBOX_READY_ATTEMPTS} ] || { echo "sandbox ${target.sandbox} did not reach ${phase}" >&2; exit 1; }
  sleep 2
done`;
  return runInLinux(
    target,
    `openshell sandbox stop ${name} </dev/null >/dev/null
${waitFor("Stopped")}
openshell sandbox start ${name} </dev/null >/dev/null
${waitFor("Ready")}`,
    platform,
  );
};

/** A folder outside git has nothing tracked, so its box starts empty. */
const listTrackedFiles = (hostCwd: string): Promise<ReadonlyArray<string>> =>
  run("git", ["-C", hostCwd, "ls-files", "-z", "--cached"]).then(parseTrackedFiles, () => []);

/** Creates the box, copies tracked files in and records a baseline. Safe to repeat on resume. */
export const stageProject = async (
  target: OpenShellTarget,
  hostCwd: string,
  platform: NodeJS.Platform,
): Promise<void> => {
  await ensureSandbox(target, platform);
  if (await isStaged(target, platform)) return;
  const files = await listTrackedFiles(hostCwd);
  if (files.length > 0) {
    const archive = await run(
      "tar",
      ["-cf", "-", "--null", "-T", "-"],
      Buffer.from(files.join("\0") + "\0"),
      hostCwd,
    );
    // Upload keeps the source directory's name, so staging mirrors the workdir's.
    const root = stagingRoot(target.sandbox);
    const staging = `${root}/${NodePath.posix.basename(target.workdir)}`;
    await runInLinux(
      target,
      `set -e; rm -rf "${root}"; mkdir -p "${staging}"; tar -xf - -C "${staging}"; openshell sandbox upload --no-git-ignore ${quote(target.sandbox)} "${staging}" ${quote(NodePath.posix.dirname(target.workdir))} </dev/null; rm -rf "${root}"`,
      platform,
      archive,
    );
  } else {
    await execInSandboxRoot(target, `mkdir -p ${quote(target.workdir)}`, platform);
  }
  await execInSandboxRoot(target, writeInstructionsScript, platform);
  await execInBox(
    target,
    `set -e; git init -q; git config core.autocrlf false; git config user.name T3; git config user.email t3@localhost; git add -A; git commit -q --allow-empty -m ${quote(BASELINE_MESSAGE)}`,
    platform,
  );
};

const isStaged = async (target: OpenShellTarget, platform: NodeJS.Platform) => {
  const result = await execInSandboxRoot(
    target,
    `test -d ${quote(`${target.workdir}/.git`)} && echo yes || echo no`,
    platform,
  );
  return result.toString().trim().endsWith("yes");
};

export const deleteSandbox = (target: OpenShellTarget, platform: NodeJS.Platform) =>
  runInLinux(target, `openshell sandbox delete ${quote(target.sandbox)} </dev/null`, platform);

/** Reads through the sandbox because the path does not exist on the host. */
export const readSandboxFile = async (
  target: OpenShellTarget,
  absolutePath: string,
  platform: NodeJS.Platform,
) => {
  const output = await execInBox(
    target,
    `head -c ${SANDBOX_READ_MAX_BYTES + 1} -- ${quote(absolutePath)}`,
    platform,
  );
  const truncated = output.length > SANDBOX_READ_MAX_BYTES;
  const bytes = output.subarray(0, SANDBOX_READ_MAX_BYTES);
  return {
    relativePath: absolutePath,
    contents: new TextDecoder("utf-8").decode(bytes, { stream: truncated }),
    byteLength: bytes.length,
    truncated,
    exists: true,
  };
};

export interface SandboxEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
}

/** Lists one folder the way the host listing does: paths are relative to the workdir. */
export const parseSandboxEntries = (
  output: string,
  directoryPath: string,
): ReadonlyArray<SandboxEntry> =>
  output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [type = "", ...name] = line.split("\t");
      const path = name.join("\t");
      return {
        path: directoryPath === "" ? path : `${directoryPath}/${path}`,
        kind: type === "d" ? ("directory" as const) : ("file" as const),
      };
    });

export const listSandboxEntries = async (
  target: OpenShellTarget,
  directoryPath: string,
  platform: NodeJS.Platform,
): Promise<ReadonlyArray<SandboxEntry>> => {
  const folder = directoryPath === "" ? "." : directoryPath;
  const output = await execInBox(
    target,
    `find ${quote(folder)} -mindepth 1 -maxdepth 1 -not -name .git -printf '%y\t%P\n' | sort -k2`,
    platform,
  );
  return parseSandboxEntries(output.toString("utf8"), directoryPath);
};

export interface SandboxChange {
  readonly path: string;
  readonly additions: number | null;
  readonly deletions: number | null;
}

/** Numstat prints `-` for binary files. */
export const quoteForShell = quote;

export const parseNumstat = (output: string): ReadonlyArray<SandboxChange> =>
  output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [additions = "-", deletions = "-", ...path] = line.split("\t");
      return {
        path: path.join("\t"),
        additions: additions === "-" ? null : Number(additions),
        deletions: deletions === "-" ? null : Number(deletions),
      };
    });

/** Everything the agent changed since the last baseline. Untracked files count. */
export const readSandboxChanges = async (
  target: OpenShellTarget,
  platform: NodeJS.Platform,
): Promise<{ readonly files: ReadonlyArray<SandboxChange>; readonly patch: Buffer }> => {
  const separator = "T3_NUMSTAT_END";
  const output = await execInBox(
    target,
    `git add -A && git -c core.quotePath=false diff --cached --numstat HEAD && echo ${separator} && git diff --cached --binary HEAD`,
    platform,
  );
  const marker = Buffer.from(`${separator}\n`);
  const split = output.indexOf(marker);
  return {
    files: parseNumstat(output.subarray(0, split).toString("utf8")),
    patch: output.subarray(split + marker.length),
  };
};

/** Applies the patch to the host, then moves the baseline so these changes are not offered again. */
export const applySandboxChanges = async (
  target: OpenShellTarget,
  hostCwd: string,
  platform: NodeJS.Platform,
): Promise<number> => {
  const { files, patch } = await readSandboxChanges(target, platform);
  if (patch.length === 0) return 0;
  await run("git", ["-C", hostCwd, "apply", "--binary", "--whitespace=nowarn", "-"], patch);
  await execInBox(target, `git add -A && git commit -q -m ${quote(BASELINE_MESSAGE)}`, platform);
  return files.length;
};
