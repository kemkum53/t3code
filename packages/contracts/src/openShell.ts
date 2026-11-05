import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const OpenShellThreadInput = Schema.Struct({ threadId: ThreadId });
export type OpenShellThreadInput = typeof OpenShellThreadInput.Type;

export const OpenShellChangedFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  additions: Schema.NullOr(NonNegativeInt),
  deletions: Schema.NullOr(NonNegativeInt),
});
export type OpenShellChangedFile = typeof OpenShellChangedFile.Type;

export const OpenShellSandboxChanges = Schema.Struct({
  sandboxed: Schema.Boolean,
  sandbox: Schema.NullOr(TrimmedNonEmptyString),
  workdir: Schema.NullOr(TrimmedNonEmptyString),
  files: Schema.Array(OpenShellChangedFile),
  diff: Schema.String,
});
export type OpenShellSandboxChanges = typeof OpenShellSandboxChanges.Type;

export const OpenShellApplyResult = Schema.Struct({ appliedFiles: NonNegativeInt });
export type OpenShellApplyResult = typeof OpenShellApplyResult.Type;

export class OpenShellSandboxChangesError extends Schema.TaggedError<OpenShellSandboxChangesError>()(
  "OpenShellSandboxChangesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
