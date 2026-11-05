// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import type {
  SpawnOptions as ClaudeSpawnOptions,
  SpawnedProcess as ClaudeSpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";

const SANDBOX_ENV = "T3_OPENSHELL_SANDBOX";
const WORKDIR_ENV = "T3_OPENSHELL_WORKDIR";
const WSL_DISTRO_ENV = "T3_OPENSHELL_WSL_DISTRO";
const SANDBOX_CLAUDE_BINARY = "/usr/local/bin/claude";

/** Credentials stay on the gateway, so only these non-secret settings cross into a sandbox. */
const FORWARDED_ENV =
  /^(CLAUDE_AGENT_SDK_|CLAUDE_CODE_(ENTRYPOINT|AUTO_COMPACT_WINDOW|ENABLE_TODO_TOOLS|DISABLE_NONESSENTIAL_TRAFFIC|PROMPT_CACHE_TTL)$|MAX_THINKING_TOKENS$)/;

export interface OpenShellTarget {
  readonly sandbox: string;
  readonly workdir: string;
  readonly wslDistro: string | undefined;
}

export const resolveOpenShellTarget = (
  environment: NodeJS.ProcessEnv | undefined,
): OpenShellTarget | undefined => {
  const sandbox = environment?.[SANDBOX_ENV]?.trim();
  if (!sandbox) return undefined;
  return {
    sandbox,
    workdir: environment?.[WORKDIR_ENV]?.trim() || "/sandbox",
    wslDistro: environment?.[WSL_DISTRO_ENV]?.trim() || undefined,
  };
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
