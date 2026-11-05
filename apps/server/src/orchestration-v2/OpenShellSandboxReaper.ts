import { OpenShellSandboxChangesError, type ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { deleteSandbox } from "./Adapters/ClaudeOpenShellWorkspace.ts";
import { resolveSandboxForDeletedThread } from "./OpenShellThreadSandbox.ts";
import * as Orchestrator from "./Orchestrator.ts";

/** A box outlives its session on purpose, so deleting the thread is what frees its disk. */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const platform = yield* HostProcess.Platform;

  const reap = Effect.fn("OpenShellSandboxReaper.reap")(function* (threadId: ThreadId) {
    const settings = yield* serverSettings.getSettings;
    const target = resolveSandboxForDeletedThread(threadId, settings.providerInstances);
    if (target === undefined) return;
    yield* Effect.tryPromise({
      try: () => deleteSandbox(target, platform),
      catch: (cause) =>
        new OpenShellSandboxChangesError({
          message: `Could not delete sandbox ${target.sandbox}`,
          cause,
        }),
    });
  });

  const start = Effect.fn("OpenShellSandboxReaper.start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "thread.deleted"
          ? reap(event.threadId).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("sandbox was not deleted", { threadId: event.threadId, cause }),
              ),
            )
          : Effect.void,
      ),
    );
  });
  return { start };
});
