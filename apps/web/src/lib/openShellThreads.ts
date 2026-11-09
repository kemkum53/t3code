import {
  OPENSHELL_SANDBOX_AUTH_TYPE,
  type ModelSelection,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";

export interface SandboxTemplateChoice {
  readonly name: string;
  readonly modelSelection: ModelSelection;
}

export const sandboxTemplateChoices = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<SandboxTemplateChoice> =>
  providers.flatMap((provider) => {
    if (!provider.enabled || provider.auth.type !== OPENSHELL_SANDBOX_AUTH_TYPE) return [];
    const model = provider.models.find(({ isDefault }) => isDefault) ?? provider.models[0];
    return model === undefined
      ? []
      : [
          {
            name: provider.displayName ?? provider.instanceId,
            modelSelection: { instanceId: provider.instanceId, model: model.slug },
          },
        ];
  });

interface DeletedThread {
  readonly environmentId: EnvironmentId;
  readonly modelSelection?: { readonly instanceId: string } | undefined;
}

const isSandboxedThread = (thread: DeletedThread): boolean => {
  const instanceId = thread.modelSelection?.instanceId;
  if (instanceId === undefined) return false;
  const providers =
    appAtomRegistry
      .get(environmentPresentations.providersByEnvironmentAtom)
      .get(thread.environmentId) ?? [];
  return providers.some(
    (provider) =>
      provider.instanceId === instanceId && provider.auth.type === OPENSHELL_SANDBOX_AUTH_TYPE,
  );
};

/** Extra delete prompt line. It only informs, so missing data never blocks the delete. */
export const sandboxDeleteNotice = (
  threads: ReadonlyArray<DeletedThread>,
): ReadonlyArray<string> => {
  const sandboxed = threads.filter(isSandboxedThread).length;
  if (sandboxed === 0) return [];
  return threads.length === 1
    ? ["Its sandbox is deleted too, with every file in it."]
    : [
        `${sandboxed} sandbox${sandboxed === 1 ? " is" : "es are"} deleted too, with every file in them.`,
      ];
};

export type SandboxState = "running" | "stopped" | "starting";

/** OpenShell has more phases than a person needs, and anything unknown is still on its way. */
export const sandboxStateOfPhase = (phase: string | null): SandboxState => {
  if (phase === "Ready") return "running";
  return phase !== null && /stop|error|fail/i.test(phase) ? "stopped" : "starting";
};
