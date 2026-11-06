import {
  OPENSHELL_SANDBOX_AUTH_TYPE,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";

/** The first enabled template wins, and the composer can still switch to another one. */
export const firstSandboxModelSelection = (
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null => {
  const provider = providers.find(
    ({ auth, enabled }) => enabled && auth.type === OPENSHELL_SANDBOX_AUTH_TYPE,
  );
  const model = provider?.models.find(({ isDefault }) => isDefault) ?? provider?.models[0];
  return provider === undefined || model === undefined
    ? null
    : { instanceId: provider.instanceId, model: model.slug };
};
