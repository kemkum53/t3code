// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import type { OpenShellTarget } from "./ClaudeOpenShellSpawn.ts";

const BASELINE_MESSAGE = "T3 baseline";
const SANDBOX_READ_MAX_BYTES = 1024 * 1024;

const quote = (value: string): string => `'${value.split("'").join("'\\''")}'`;

/** Staging lives on the Linux filesystem: uploads from /mnt/<drive> lose their content. */
const stagingRoot = (sandbox: string): string => `$HOME/.cache/t3-openshell/${sandbox}`;

const linuxCommand = (target: OpenShellTarget, script: string, platform: NodeJS.Platform) =>
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

const runInLinux = (
  target: OpenShellTarget,
  script: string,
  platform: NodeJS.Platform,
  input?: Buffer,
): Promise<Buffer> => {
  const { command, args } = linuxCommand(target, script, platform);
  return run(command, args, input);
};

const execInBox = (target: OpenShellTarget, script: string, platform: NodeJS.Platform) =>
  runInLinux(
    target,
    `exec openshell sandbox exec --name ${quote(target.sandbox)} --no-tty --timeout 0 --workdir ${quote(target.workdir)} -- sh -c ${quote(script)} </dev/null`,
    platform,
  );

const parseTrackedFiles = (listing: Buffer): ReadonlyArray<string> =>
  listing.toString("utf8").split("\0").filter(Boolean);

/** Copies tracked files into the box and records a baseline. Safe to repeat on a resumed thread. */
export const stageProject = async (
  target: OpenShellTarget,
  hostCwd: string,
  platform: NodeJS.Platform,
): Promise<void> => {
  const ready = await execBoxIfPresent(target, platform);
  if (ready) return;
  const listing = await run("git", ["-C", hostCwd, "ls-files", "-z", "--cached"]);
  const archive = await run(
    "tar",
    ["-cf", "-", "--null", "-T", "-"],
    Buffer.from(parseTrackedFiles(listing).join("\0") + "\0"),
    hostCwd,
  );
  // Upload keeps the source directory's name, so staging mirrors the workdir's.
  const root = stagingRoot(target.sandbox);
  const staging = `${root}/${NodePath.posix.basename(target.workdir)}`;
  await runInLinux(
    target,
    `set -e; rm -rf "${root}"; mkdir -p "${staging}"; tar -xf - -C "${staging}"; exec openshell sandbox upload --no-git-ignore ${quote(target.sandbox)} "${staging}" ${quote(NodePath.posix.dirname(target.workdir))} </dev/null`,
    platform,
    archive,
  );
  await execInBox(
    target,
    `set -e; git init -q; git config core.autocrlf false; git config user.name T3; git config user.email t3@localhost; git add -A; git commit -q --allow-empty -m ${quote(BASELINE_MESSAGE)}`,
    platform,
  );
};

const execBoxIfPresent = async (target: OpenShellTarget, platform: NodeJS.Platform) => {
  const result = await runInLinux(
    target,
    `exec openshell sandbox exec --name ${quote(target.sandbox)} --no-tty -- sh -c ${quote(`test -d ${quote(`${target.workdir}/.git`)} && echo yes || echo no`)} </dev/null`,
    platform,
  );
  return result.toString().trim().endsWith("yes");
};

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
