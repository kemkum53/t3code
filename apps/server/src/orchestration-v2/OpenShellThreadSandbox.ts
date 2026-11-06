// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

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
  readonly template: string | null;
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

/** A chat without a project runs in a folder under the scratch root, so nothing can receive a patch. */
export const isInsideFolder = (path: string, folder: string): boolean => {
  const relative = NodePath.relative(folder, path);
  return !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

/** The latest provider session names the instance that holds the sandbox profile. */
export const resolveThreadSandbox = (
  threadId: ThreadId,
  projection: Pick<OrchestrationV2ThreadProjection, "providerSessions">,
  instances: ProviderInstances,
): ThreadSandbox | undefined => {
  const session = projection.providerSessions.at(-1);
  if (session === undefined) return undefined;
  const instance = instances[session.providerInstanceId];
  const profile = instanceProfile(instance);
  return profile === undefined
    ? undefined
    : {
        target: targetForThread(profile, threadId),
        hostCwd: session.cwd,
        template: instance?.displayName ?? null,
      };
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
