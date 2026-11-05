import type { OrchestrationV2ThreadProjection, ServerSettings, ThreadId } from "@t3tools/contracts";

import {
  resolveOpenShellProfile,
  sandboxForWorkdir,
  targetForThread,
  type OpenShellProfile,
  type OpenShellTarget,
} from "./Adapters/ClaudeOpenShellSpawn.ts";

type ProviderInstances = ServerSettings["providerInstances"];

export interface ThreadSandbox {
  readonly target: OpenShellTarget;
  readonly hostCwd: string;
}

const instanceProfile = (
  instance: ProviderInstances[keyof ProviderInstances] | undefined,
): OpenShellProfile | undefined => {
  const entries = (instance?.environment ?? []).flatMap((variable) =>
    typeof variable.value === "string" ? [[variable.name, variable.value] as const] : [],
  );
  return resolveOpenShellProfile(Object.fromEntries(entries));
};

export const firstProfile = (instances: ProviderInstances) =>
  Object.values(instances)
    .map(instanceProfile)
    .find((candidate) => candidate !== undefined);

/** The latest provider session names the instance that holds the sandbox profile. */
export const resolveThreadSandbox = (
  threadId: ThreadId,
  projection: Pick<OrchestrationV2ThreadProjection, "providerSessions">,
  instances: ProviderInstances,
): ThreadSandbox | undefined => {
  const session = projection.providerSessions.at(-1);
  if (session === undefined) return undefined;
  const profile = instanceProfile(instances[session.providerInstanceId]);
  return profile === undefined
    ? undefined
    : { target: targetForThread(profile, threadId), hostCwd: session.cwd };
};

/** A box path carries its sandbox's name, so it needs no thread to find the right box. */
export const resolveSandboxForPath = (
  path: string,
  instances: ProviderInstances,
): OpenShellTarget | undefined => {
  const sandbox = sandboxForWorkdir(path);
  if (sandbox === undefined) return undefined;
  const profile = firstProfile(instances);
  return profile === undefined
    ? undefined
    : { ...profile, sandbox, workdir: `/sandbox/${sandbox}` };
};

/** A deleted thread has no session left to read, so any configured profile reaches its box. */
export const resolveSandboxForDeletedThread = (
  threadId: ThreadId,
  instances: ProviderInstances,
): OpenShellTarget | undefined => {
  const profile = firstProfile(instances);
  return profile === undefined ? undefined : targetForThread(profile, threadId);
};
