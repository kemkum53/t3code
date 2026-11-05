import type { OrchestrationV2ThreadProjection, ServerSettings } from "@t3tools/contracts";

import { resolveOpenShellTarget, type OpenShellTarget } from "./Adapters/ClaudeOpenShellSpawn.ts";

export interface ThreadSandbox {
  readonly target: OpenShellTarget;
  readonly hostCwd: string;
}

/** The latest provider session names the instance whose environment selects the sandbox. */
export const resolveThreadSandbox = (
  projection: Pick<OrchestrationV2ThreadProjection, "providerSessions">,
  instances: ServerSettings["providerInstances"],
): ThreadSandbox | undefined => {
  const session = projection.providerSessions.at(-1);
  if (session === undefined) return undefined;
  const entries = (instances[session.providerInstanceId]?.environment ?? []).flatMap((variable) =>
    typeof variable.value === "string" ? [[variable.name, variable.value] as const] : [],
  );
  const target = resolveOpenShellTarget(Object.fromEntries(entries));
  return target === undefined ? undefined : { target, hostCwd: session.cwd };
};
