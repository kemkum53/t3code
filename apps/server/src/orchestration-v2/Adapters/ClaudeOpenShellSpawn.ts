// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import type {
  SpawnOptions as ClaudeSpawnOptions,
  SpawnedProcess as ClaudeSpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";

const IMAGE_ENV = "T3_OPENSHELL_IMAGE";
const POLICY_ENV = "T3_OPENSHELL_POLICY";
const PROVIDER_ENV = "T3_OPENSHELL_PROVIDER";
const WSL_DISTRO_ENV = "T3_OPENSHELL_WSL_DISTRO";
const SANDBOX_ROOT = "/sandbox";
const SANDBOX_CLAUDE_BINARY = "/usr/local/bin/claude";

/** Credentials stay on the gateway, so only these non-secret settings cross into a sandbox. */
const FORWARDED_ENV =
  /^(CLAUDE_AGENT_SDK_|CLAUDE_CODE_(ENTRYPOINT|AUTO_COMPACT_WINDOW|ENABLE_TODO_TOOLS|DISABLE_NONESSENTIAL_TRAFFIC|PROMPT_CACHE_TTL)$|MAX_THINKING_TOKENS$)/;

export interface OpenShellProfile {
  readonly image: string;
  readonly policy: string | undefined;
  readonly provider: string | undefined;
  readonly wslDistro: string | undefined;
}

export interface OpenShellTarget extends OpenShellProfile {
  readonly sandbox: string;
  readonly workdir: string;
}

export const resolveOpenShellProfile = (
  environment: NodeJS.ProcessEnv | undefined,
): OpenShellProfile | undefined => {
  const image = environment?.[IMAGE_ENV]?.trim();
  if (!image) return undefined;
  return {
    image,
    policy: environment?.[POLICY_ENV]?.trim() || undefined,
    provider: environment?.[PROVIDER_ENV]?.trim() || undefined,
    wslDistro: environment?.[WSL_DISTRO_ENV]?.trim() || undefined,
  };
};

/** Enough for the terminal manager to find the box without knowing about threads. */
export const sandboxTerminalEnv = (profile: OpenShellProfile): Record<string, string> => ({
  [IMAGE_ENV]: profile.image,
  ...(profile.wslDistro === undefined ? {} : { [WSL_DISTRO_ENV]: profile.wslDistro }),
});

/** Every thread owns a box, and the name stays stable so a resumed thread finds it again. */
export const targetForThread = (profile: OpenShellProfile, threadId: string): OpenShellTarget => {
  const sandbox = `t3-${threadId.replaceAll("-", "").slice(0, 12).toLowerCase()}`;
  return { ...profile, sandbox, workdir: `${SANDBOX_ROOT}/${sandbox}` };
};

export const resolveOpenShellTarget = (
  environment: NodeJS.ProcessEnv | undefined,
  threadId: string,
): OpenShellTarget | undefined => {
  const profile = resolveOpenShellProfile(environment);
  return profile === undefined ? undefined : targetForThread(profile, threadId);
};

/** Returns the sandbox a box path belongs to. Paths that climb upward never match. */
export const sandboxForWorkdir = (path: string): string | undefined => {
  if (path.split("/").includes("..")) return undefined;
  return /^\/sandbox\/(t3-[a-z0-9]+)(?:\/|$)/.exec(path)?.[1];
};

export const forwardedEnvironment = (environment: NodeJS.ProcessEnv): ReadonlyArray<string> =>
  Object.entries(environment)
    .filter(([name, value]) => value !== undefined && FORWARDED_ENV.test(name))
    .map(([name, value]) => `${name}=${value}`)
    .sort();

export const buildOpenShellCommand = (
  target: OpenShellTarget,
  claudeArgs: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { readonly command: string; readonly args: ReadonlyArray<string> } => {
  const exec = [
    "sandbox",
    "exec",
    "--name",
    target.sandbox,
    "--no-tty",
    "--timeout",
    "0",
    "--workdir",
    target.workdir,
    ...forwardedEnvironment(environment).flatMap((entry) => ["--env", entry]),
    "--",
    SANDBOX_CLAUDE_BINARY,
    ...claudeArgs,
  ];
  if (platform !== "win32") return { command: "openshell", args: exec };
  return {
    command: "wsl.exe",
    args: [
      ...(target.wslDistro === undefined ? [] : ["-d", target.wslDistro]),
      "--cd",
      "~",
      "-e",
      "openshell",
      ...exec,
    ],
  };
};

export const spawnClaudeInOpenShell = (
  target: OpenShellTarget,
  options: ClaudeSpawnOptions,
  platform: NodeJS.Platform,
  onStderr: (text: string) => void,
): ClaudeSpawnedProcess => {
  const { command, args } = buildOpenShellCommand(target, options.args, options.env, platform);
  const child = NodeChildProcess.spawn(command, args, {
    signal: options.signal,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8").on("data", onStderr);
  return child;
};
