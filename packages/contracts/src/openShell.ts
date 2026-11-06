import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Reported as a provider auth type, so clients can tell isolated instances apart. */
export const OPENSHELL_SANDBOX_AUTH_TYPE = "openShellSandbox";

export const OpenShellThreadInput = Schema.Struct({ threadId: ThreadId });
export type OpenShellThreadInput = typeof OpenShellThreadInput.Type;

export const OpenShellChangedFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  additions: Schema.NullOr(NonNegativeInt),
  deletions: Schema.NullOr(NonNegativeInt),
});
export type OpenShellChangedFile = typeof OpenShellChangedFile.Type;

export const OpenShellAccessRequest = Schema.Struct({
  chunkId: Schema.NullOr(TrimmedNonEmptyString),
  binary: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  port: NonNegativeInt,
});
export type OpenShellAccessRequest = typeof OpenShellAccessRequest.Type;

export const OpenShellSandboxRequests = Schema.Struct({
  requests: Schema.Array(OpenShellAccessRequest),
});
export type OpenShellSandboxRequests = typeof OpenShellSandboxRequests.Type;

export const OpenShellFileDenial = Schema.Struct({
  command: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type OpenShellFileDenial = typeof OpenShellFileDenial.Type;

export const OpenShellSandboxChanges = Schema.Struct({
  sandboxed: Schema.Boolean,
  sandbox: Schema.NullOr(TrimmedNonEmptyString),
  workdir: Schema.NullOr(TrimmedNonEmptyString),
  template: Schema.NullOr(TrimmedNonEmptyString),
  hasProject: Schema.Boolean,
  blockedFileCount: NonNegativeInt,
  files: Schema.Array(OpenShellChangedFile),
  diff: Schema.String,
});
export type OpenShellSandboxChanges = typeof OpenShellSandboxChanges.Type;

export const OpenShellApplyResult = Schema.Struct({ appliedFiles: NonNegativeInt });
export type OpenShellApplyResult = typeof OpenShellApplyResult.Type;

export const OpenShellGuardRule = Schema.Struct({
  name: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  port: NonNegativeInt,
  binaries: Schema.Array(TrimmedNonEmptyString),
  managed: Schema.Boolean,
});
export type OpenShellGuardRule = typeof OpenShellGuardRule.Type;

export const OpenShellDenial = Schema.Struct({
  binary: TrimmedNonEmptyString,
  host: TrimmedNonEmptyString,
  port: NonNegativeInt,
  count: NonNegativeInt,
});
export type OpenShellDenial = typeof OpenShellDenial.Type;

export const OpenShellSandboxGuard = Schema.Struct({
  sandbox: TrimmedNonEmptyString,
  phase: TrimmedNonEmptyString,
  rules: Schema.Array(OpenShellGuardRule),
  denials: Schema.Array(OpenShellDenial),
  requests: Schema.Array(OpenShellAccessRequest),
  fileDenials: Schema.Array(OpenShellFileDenial),
  readOnlyPaths: Schema.Array(Schema.String),
  writablePaths: Schema.Array(Schema.String),
});
export type OpenShellSandboxGuard = typeof OpenShellSandboxGuard.Type;

export const OpenShellSandboxGuardChange = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("allow"),
    host: TrimmedNonEmptyString,
    port: NonNegativeInt,
    binary: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("remove"),
    host: TrimmedNonEmptyString,
    port: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("deny"),
    host: TrimmedNonEmptyString,
    port: NonNegativeInt,
    binary: TrimmedNonEmptyString,
    chunkId: Schema.NullOr(TrimmedNonEmptyString),
  }),
  Schema.Struct({ type: Schema.Literal("stop") }),
  Schema.Struct({ type: Schema.Literal("start") }),
]);
export type OpenShellSandboxGuardChange = typeof OpenShellSandboxGuardChange.Type;

export const OpenShellUpdateGuardInput = Schema.Struct({
  threadId: ThreadId,
  change: OpenShellSandboxGuardChange,
});
export type OpenShellUpdateGuardInput = typeof OpenShellUpdateGuardInput.Type;

export const OpenShellSandboxSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  phase: TrimmedNonEmptyString,
  createdAt: Schema.String,
});
export type OpenShellSandboxSummary = typeof OpenShellSandboxSummary.Type;

export const OpenShellOverview = Schema.Struct({
  configured: Schema.Boolean,
  idleStopMinutes: NonNegativeInt,
  linuxAvailable: Schema.Boolean,
  sudoNeedsPassword: Schema.Boolean,
  setupStep: Schema.NullOr(TrimmedNonEmptyString),
  version: Schema.NullOr(TrimmedNonEmptyString),
  gatewayActive: Schema.Boolean,
  kvmAvailable: Schema.Boolean,
  imageAvailable: Schema.Boolean,
  credentialStored: Schema.Boolean,
  freeDiskGb: NonNegativeInt,
  sandboxes: Schema.Array(OpenShellSandboxSummary),
});
export type OpenShellOverview = typeof OpenShellOverview.Type;

export const OpenShellSaveCredentialInput = Schema.Struct({ token: TrimmedNonEmptyString });
export type OpenShellSaveCredentialInput = typeof OpenShellSaveCredentialInput.Type;

export const OpenShellSetupInput = Schema.Struct({ sudoPassword: Schema.String });
export type OpenShellSetupInput = typeof OpenShellSetupInput.Type;

export const OpenShellControlSandboxInput = Schema.Struct({
  sandbox: TrimmedNonEmptyString,
  action: Schema.Literals(["stop", "start", "delete"]),
});
export type OpenShellControlSandboxInput = typeof OpenShellControlSandboxInput.Type;

export class OpenShellSandboxChangesError extends Schema.TaggedError<OpenShellSandboxChangesError>()(
  "OpenShellSandboxChangesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
