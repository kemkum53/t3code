import {
  OPENSHELL_SANDBOX_AUTH_TYPE,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";

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

export type SandboxState = "running" | "stopped" | "starting";

/** OpenShell has more phases than a person needs, and anything unknown is still on its way. */
export const sandboxStateOfPhase = (phase: string | null): SandboxState => {
  if (phase === "Ready") return "running";
  return phase !== null && /stop|error|fail/i.test(phase) ? "stopped" : "starting";
};
