import type {
  OpenShellDenial,
  OpenShellGuardRule,
  OpenShellOverview,
  OpenShellSandboxSummary,
} from "@t3tools/contracts";

import type { OpenShellProfile, OpenShellTarget } from "./ClaudeOpenShellSpawn.ts";
import { quoteForShell as quote, runInLinux } from "./ClaudeOpenShellWorkspace.ts";

const HOST_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/;
const BINARY_PATTERN = /^\/[\w./+-]+$/;
const SANDBOX_PATTERN = /^t3-[a-z0-9]+$/;
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

export const readGuard = async (target: OpenShellTarget, platform: NodeJS.Platform) => {
  const name = quote(target.sandbox);
  const [sandbox, policy, logs] = await Promise.all([
    openshell(target, `sandbox get ${name} -o json`, platform),
    openshell(target, `policy get ${name} --full -o json`, platform),
    openshell(target, `logs ${name} --since ${DENIAL_LOG_WINDOW} -n 500`, platform),
  ]);
  const { phase } = JSON.parse(sandbox) as { readonly phase: string };
  const { policy: active } = JSON.parse(policy) as {
    readonly policy: { readonly network_policies?: Readonly<Record<string, PolicyRule>> };
  };
  return {
    sandbox: target.sandbox,
    phase,
    rules: parseRules(active.network_policies ?? {}),
    denials: parseDenials(logs),
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
  const image = profile?.image ?? "";
  const provider = quote(profile?.provider ?? DEFAULT_CREDENTIAL_PROVIDER);
  return `echo "version=$(openshell --version 2>/dev/null)"
echo "gateway=$(XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active openshell-gateway 2>/dev/null)"
[ -r /dev/kvm ] && [ -w /dev/kvm ] && echo "kvm=yes" || echo "kvm=no"
[ -n "${image}" ] && [ -e "${image}" ] && echo "image=yes" || echo "image=no"
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

export const readOverview = async (
  profile: OpenShellProfile | undefined,
  platform: NodeJS.Platform,
): Promise<OpenShellOverview> => {
  const host = { wslDistro: profile?.wslDistro };
  const checks = parseHostChecks(
    (await runInLinux(host, HOST_CHECK_SCRIPT(profile), platform)).toString("utf8"),
  );
  const list = await runInLinux(host, "exec openshell sandbox list -o json </dev/null", platform)
    .then((output) => parseSandboxList(output.toString("utf8")))
    .catch(() => []);
  return {
    configured: profile !== undefined,
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
  await runInLinux({ wslDistro: profile?.wslDistro }, script, platform, Buffer.from(`${token}\n`));
};
