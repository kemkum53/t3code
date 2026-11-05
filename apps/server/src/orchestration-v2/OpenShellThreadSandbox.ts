import type { OrchestrationV2ThreadProjection, ServerSettings } from "@t3tools/contracts";

import { resolveOpenShellTarget, type OpenShellTarget } from "./Adapters/ClaudeOpenShellSpawn.ts";

export interface ThreadSandbox {
  readonly target: OpenShellTarget;
  readonly hostCwd: string;
}

const instanceTarget = (
  instance:
    | ServerSettings["providerInstances"][keyof ServerSettings["providerInstances"]]
    | undefined,
): OpenShellTarget | undefined => {
  const entries = (instance?.environment ?? []).flatMap((variable) =>
    typeof variable.value === "string" ? [[variable.name, variable.value] as const] : [],
  );
  return resolveOpenShellTarget(Object.fromEntries(entries));
};

/** The latest provider session names the instance whose environment selects the sandbox. */
export const resolveThreadSandbox = (
  projection: Pick<OrchestrationV2ThreadProjection, "providerSessions">,
  instances: ServerSettings["providerInstances"],
): ThreadSandbox | undefined => {
  const session = projection.providerSessions.at(-1);
  if (session === undefined) return undefined;
  const target = instanceTarget(instances[session.providerInstanceId]);
  return target === undefined ? undefined : { target, hostCwd: session.cwd };
};

/** Agents report box paths, which name a file only inside the sandbox that owns the workdir. */
export const resolveSandboxForPath = (
  path: string,
  instances: ServerSettings["providerInstances"],
): OpenShellTarget | undefined => {
  if (path.split("/").includes("..")) return undefined;
  return Object.values(instances)
    .map(instanceTarget)
    .find((target) => target !== undefined && path.startsWith(`${target.workdir}/`));
};
