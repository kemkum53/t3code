import type {
  OpenShellAccessRequest,
  OpenShellDenial,
  OpenShellFileDenial,
  OpenShellGuardRule,
  OpenShellOverview,
  OpenShellSandboxSummary,
} from "@t3tools/contracts";

import type { OpenShellProfile, OpenShellTarget } from "./ClaudeOpenShellSpawn.ts";
import { DEFAULT_IMAGE_PATH, isSetupRunning, SETUP_STEP_FILE } from "./ClaudeOpenShellSetup.ts";
import {
  quoteForShell as quote,
  resolveHostDistro,
  runInLinux,
} from "./ClaudeOpenShellWorkspace.ts";

const HOST_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/;
const BINARY_PATTERN = /^\/[\w./+-]+$/;
const SANDBOX_PATTERN = /^t3-[a-z0-9]+$/;
const CHUNK_PATTERN = /^[0-9a-f-]{36}$/;
const FILE_DENIAL_PATTERN =
  /.*(?:Permission denied|Operation not permitted|Read-only file system).*/;
const FILE_DENIAL_WINDOW_MS = 30 * 60_000;
const MAX_FILE_DENIALS = 10;
const SECTION_MARKER = "__T3_SECTION__";
const USER_RULE_PREFIX = "t3_user_";
const DEFAULT_CREDENTIAL_PROVIDER = "claude-sub";
const CREDENTIAL_PROFILE = "claude-subscription";
const DENIAL_LOG_WINDOW = "30m";

/** Claude's telemetry is refused on purpose, so listing it only hides real denials. */
const EXPECTED_DENIALS = /(^|\.)datadoghq\.com$/;

interface PolicyEndpoint {
  readonly host?: string;
  readonly port?: number;
}

interface PolicyFiles {
  readonly read_only?: ReadonlyArray<string>;
  readonly read_write?: ReadonlyArray<string>;
}

interface PolicyRule {
  readonly binaries?: ReadonlyArray<{ readonly path?: string }>;
  readonly endpoints?: ReadonlyArray<PolicyEndpoint>;
}

export const assertSandboxName = (sandbox: string): string => {
  if (!SANDBOX_PATTERN.test(sandbox)) throw new Error(`Invalid sandbox name: ${sandbox}`);
  return sandbox;
};

const endpoint = (host: string, port: number): string => {
  if (!HOST_PATTERN.test(host)) throw new Error(`Invalid host: ${host}`);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${port}`);
  }
  return `${host}:${port}`;
};

const userRuleName = (binary: string): string =>
  `${USER_RULE_PREFIX}${binary.split("/").at(-1)?.replace(/\W/g, "_") ?? "any"}`;

export const parseDenials = (logs: string): ReadonlyArray<OpenShellDenial> => {
  const counts = new Map<string, OpenShellDenial>();
  for (const match of logs.matchAll(/DENIED (\S+?)\(\d+\) -> ([^:\s]+):(\d+)/g)) {
    const [, binary = "", host = "", port = "0"] = match;
    if (EXPECTED_DENIALS.test(host)) continue;
    const key = `${binary} ${host}:${port}`;
    const seen = counts.get(key);
    counts.set(key, { binary, host, port: Number(port), count: (seen?.count ?? 0) + 1 });
  }
  return [...counts.values()];
};

/** The CLI has no JSON form for rules, so requests are read from its labelled text. */
export const parseAccessRequests = (output: string): ReadonlyArray<ChunkRequest> =>
  output
    .split(/^\s*Chunk:\s*/m)
    .slice(1)
    .flatMap((block) => {
      const field = (label: string) =>
        new RegExp(`^\\s*${label}:\\s*(.+)$`, "m").exec(block)?.[1]?.trim() ?? "";
      const chunkId = block.split("\n")[0]?.trim() ?? "";
      const target = /^([^:\s]+):(\d+)/.exec(field("Endpoints"));
      if (field("Status") !== "pending" || target === null) return [];
      const [, host = "", port = "0"] = target;
      if (EXPECTED_DENIALS.test(host)) return [];
      return [
        {
          chunkId,
          binary: field("Binary"),
          host,
          port: Number(port),
        },
      ];
    });

type ChunkRequest = OpenShellAccessRequest & { readonly chunkId: string };

const accessKey = (sandbox: string, { binary, host, port }: Omit<OpenShellDenial, "count">) =>
  `${sandbox} ${binary} ${host}:${port}`;

/** A log line appears at once, and the gateway's draft only about ten seconds later. */
const deniedByUser = new Set<string>();

export const mergeAccessRequests = (
  sandbox: string,
  denials: ReadonlyArray<OpenShellDenial>,
  pending: ReadonlyArray<ChunkRequest>,
  rules: ReadonlyArray<OpenShellGuardRule>,
): ReadonlyArray<OpenShellAccessRequest> => {
  const allowed = ({ binary, host, port }: Omit<OpenShellDenial, "count">) =>
    rules.some(
      (rule) =>
        rule.host === host &&
        rule.port === port &&
        (rule.binaries.length === 0 || rule.binaries.includes(binary)),
    );
  const fromLogs = denials.map(({ binary, host, port }) => ({
    chunkId: pending.find(
      (chunk) => chunk.binary === binary && chunk.host === host && chunk.port === port,
    )?.chunkId,
    binary,
    host,
    port,
  }));
  const known = new Set(fromLogs.map((request) => accessKey(sandbox, request)));
  const fromChunks = pending.filter((chunk) => !known.has(accessKey(sandbox, chunk)));
  return [...fromLogs, ...fromChunks].flatMap(({ chunkId, binary, host, port }) =>
    allowed({ binary, host, port }) || deniedByUser.has(accessKey(sandbox, { binary, host, port }))
      ? []
      : [{ chunkId: chunkId ?? null, binary, host, port }],
  );
};

/** Landlock refuses in the kernel without a log line, so the agent's own output is the only trace. */
export const parseFileDenials = (
  items: ReadonlyArray<{
    readonly type: string;
    readonly input?: unknown;
    readonly output?: unknown;
    readonly startedAt?: unknown;
  }>,
  now: number,
): ReadonlyArray<OpenShellFileDenial> => {
  const denials = items.flatMap(({ type, input, output, startedAt }) => {
    if (type !== "command_execution" || typeof output !== "string") return [];
    if (now - Date.parse(String(startedAt)) > FILE_DENIAL_WINDOW_MS) return [];
    const message = FILE_DENIAL_PATTERN.exec(output)?.[0]?.trim();
    return message === undefined ? [] : [{ command: String(input).trim(), message }];
  });
  return denials.slice(-MAX_FILE_DENIALS).reverse();
};

export const parseRules = (
  policies: Readonly<Record<string, PolicyRule>>,
): ReadonlyArray<OpenShellGuardRule> =>
  Object.entries(policies).flatMap(([name, rule]) => {
    const binaries = (rule.binaries ?? []).flatMap(({ path }) => (path ? [path] : []));
    return (rule.endpoints ?? []).flatMap(({ host, port }) =>
      host === undefined || port === undefined
        ? []
        : [{ name, host, port, binaries, managed: !name.startsWith(USER_RULE_PREFIX) }],
    );
  });

export const parseSandboxList = (output: string): ReadonlyArray<OpenShellSandboxSummary> => {
  const parsed = JSON.parse(output) as {
    readonly sandboxes?: ReadonlyArray<{
      readonly name: string;
      readonly phase: string;
      readonly created_at: string;
    }>;
  };
  return (parsed.sandboxes ?? []).map(({ name, phase, created_at }) => ({
    name,
    phase,
    createdAt: created_at,
  }));
};

const openshell = async (
  target: OpenShellTarget,
  command: string,
  platform: NodeJS.Platform,
): Promise<string> =>
  (await runInLinux(target, `exec openshell ${command} </dev/null`, platform)).toString("utf8");

const parseActivePolicy = (output: string) =>
  (
    JSON.parse(output) as {
      readonly policy: {
        readonly network_policies?: Readonly<Record<string, PolicyRule>>;
        readonly filesystem_policy?: PolicyFiles;
      };
    }
  ).policy;

/** Polled every few seconds, so all three reads share one WSL process. */
export const readAccessRequests = async (target: OpenShellTarget, platform: NodeJS.Platform) => {
  const name = quote(target.sandbox);
  const output = (
    await runInLinux(
      target,
      `openshell logs ${name} --since ${DENIAL_LOG_WINDOW} -n 500 </dev/null
echo ${SECTION_MARKER}
openshell policy get ${name} --full -o json </dev/null
echo ${SECTION_MARKER}
openshell rule get ${name} --status pending </dev/null
exit 0`,
      platform,
    )
  ).toString("utf8");
  const [logs = "", policy = "{}", pending = ""] = output.split(SECTION_MARKER);
  const rules = parseRules(parseActivePolicy(policy).network_policies ?? {});
  return mergeAccessRequests(
    target.sandbox,
    parseDenials(logs),
    parseAccessRequests(pending),
    rules,
  );
};

export const denyAccessRequest = async (
  target: OpenShellTarget,
  request: {
    readonly host: string;
    readonly port: number;
    readonly binary: string;
    readonly chunkId: string | null;
  },
  platform: NodeJS.Platform,
): Promise<void> => {
  deniedByUser.add(accessKey(target.sandbox, request));
  const { chunkId } = request;
  if (chunkId === null) return;
  if (!CHUNK_PATTERN.test(chunkId)) throw new Error(`Invalid request id: ${chunkId}`);
  await openshell(
    target,
    `rule reject ${quote(target.sandbox)} --chunk-id ${quote(chunkId)} --reason ${quote("Denied by the user")}`,
    platform,
  );
};

export const readGuard = async (
  target: OpenShellTarget,
  fileDenials: ReadonlyArray<OpenShellFileDenial>,
  platform: NodeJS.Platform,
) => {
  const name = quote(target.sandbox);
  const [sandbox, policy, logs, requests] = await Promise.all([
    openshell(target, `sandbox get ${name} -o json`, platform),
    openshell(target, `policy get ${name} --full -o json`, platform),
    openshell(target, `logs ${name} --since ${DENIAL_LOG_WINDOW} -n 500`, platform),
    readAccessRequests(target, platform),
  ]);
  const { phase } = JSON.parse(sandbox) as { readonly phase: string };
  const active = parseActivePolicy(policy);
  return {
    sandbox: target.sandbox,
    phase,
    rules: parseRules(active.network_policies ?? {}),
    denials: parseDenials(logs),
    requests,
    fileDenials,
    readOnlyPaths: active.filesystem_policy?.read_only ?? [],
    writablePaths: active.filesystem_policy?.read_write ?? [],
  };
};

export const allowEndpoint = async (
  target: OpenShellTarget,
  input: { readonly host: string; readonly port: number; readonly binary: string },
  platform: NodeJS.Platform,
): Promise<void> => {
  if (!BINARY_PATTERN.test(input.binary)) throw new Error(`Invalid binary: ${input.binary}`);
  await openshell(
    target,
    `policy update ${quote(target.sandbox)} --add-endpoint ${quote(endpoint(input.host, input.port))} --binary ${quote(input.binary)} --rule-name ${quote(userRuleName(input.binary))} --wait`,
    platform,
  );
};

export const removeEndpoint = async (
  target: OpenShellTarget,
  input: { readonly host: string; readonly port: number },
  platform: NodeJS.Platform,
): Promise<void> => {
  await openshell(
    target,
    `policy update ${quote(target.sandbox)} --remove-endpoint ${quote(endpoint(input.host, input.port))} --wait`,
    platform,
  );
};

export const controlSandbox = async (
  target: OpenShellTarget,
  action: "stop" | "start" | "delete",
  platform: NodeJS.Platform,
): Promise<void> => {
  await openshell(target, `sandbox ${action} ${quote(target.sandbox)}`, platform);
};

const HOST_CHECK_SCRIPT = (profile: OpenShellProfile | undefined): string => {
  const image = profile?.image ?? DEFAULT_IMAGE_PATH;
  const provider = quote(profile?.provider ?? DEFAULT_CREDENTIAL_PROVIDER);
  return `echo "version=$(openshell --version 2>/dev/null)"
echo "gateway=$(XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active openshell-gateway 2>/dev/null)"
[ -e /dev/kvm ] && echo "kvm=yes" || echo "kvm=no"
[ -e "${image}" ] && echo "image=yes" || echo "image=no"
command -v apt-get >/dev/null && echo "apt=yes" || echo "apt=no"
sudo -n true 2>/dev/null && echo "sudo=open" || echo "sudo=password"
echo "step=$(cat "${SETUP_STEP_FILE}" 2>/dev/null)"
openshell provider get ${provider} </dev/null >/dev/null 2>&1 && echo "credential=yes" || echo "credential=no"
echo "freeGb=$(df -BG --output=avail "$HOME" | tail -1 | tr -dc 0-9)"
exit 0`;
};

export const parseHostChecks = (output: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );

export const listSandboxes = async (profile: OpenShellProfile, platform: NodeJS.Platform) =>
  parseSandboxList(
    (
      await runInLinux(profile, "exec openshell sandbox list -o json </dev/null", platform)
    ).toString("utf8"),
  );

export const readOverview = async (
  profile: OpenShellProfile | undefined,
  idleStopMinutes: number,
  platform: NodeJS.Platform,
): Promise<OpenShellOverview> => {
  const host = { wslDistro: await resolveHostDistro(profile?.wslDistro, platform) };
  const checks = parseHostChecks(
    await runInLinux(host, HOST_CHECK_SCRIPT(profile), platform)
      .then((output) => output.toString("utf8"))
      .catch(() => ""),
  );
  const list = await runInLinux(host, "exec openshell sandbox list -o json </dev/null", platform)
    .then((output) => parseSandboxList(output.toString("utf8")))
    .catch(() => []);
  return {
    configured: profile !== undefined,
    idleStopMinutes,
    linuxAvailable: checks.apt === "yes",
    sudoNeedsPassword: checks.sudo !== "open",
    setupStep: isSetupRunning() ? checks.step || "check" : null,
    version: checks.version || null,
    gatewayActive: checks.gateway === "active",
    kvmAvailable: checks.kvm === "yes",
    imageAvailable: checks.image === "yes",
    credentialStored: checks.credential === "yes",
    freeDiskGb: Number(checks.freeGb) || 0,
    sandboxes: list,
  };
};

/** The token travels through stdin, so it never appears in a process list. */
export const saveCredential = async (
  profile: OpenShellProfile | undefined,
  token: string,
  platform: NodeJS.Platform,
): Promise<void> => {
  const provider = quote(profile?.provider ?? DEFAULT_CREDENTIAL_PROVIDER);
  const script = `IFS= read -r CLAUDE_CODE_OAUTH_TOKEN
export CLAUDE_CODE_OAUTH_TOKEN
if openshell provider get ${provider} </dev/null >/dev/null 2>&1; then
  exec openshell provider update ${provider} --from-existing </dev/null
fi
exec openshell provider create --name ${provider} --type ${CREDENTIAL_PROFILE} --from-existing </dev/null`;
  await runInLinux(
    { wslDistro: await resolveHostDistro(profile?.wslDistro, platform) },
    script,
    platform,
    Buffer.from(`${token}\n`),
  );
};
