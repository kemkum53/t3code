import type { OrchestrationV2ThreadProjection, OpenShellSandboxSummary } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { controlSandbox, listSandboxes } from "./Adapters/ClaudeOpenShellGuard.ts";
import { targetForThread } from "./Adapters/ClaudeOpenShellSpawn.ts";
import { firstProfile } from "./OpenShellThreadSandbox.ts";
import * as Orchestrator from "./Orchestrator.ts";

const CHECK_INTERVAL = Duration.minutes(1);
const READY_PHASE = "Ready";

const toMillis = (value: DateTime.Utc) => DateTime.toEpochMillis(value);

/** Stopping a box kills its agent, so a live session always keeps it running. */
export const lastActivityOfThread = (
  projection: Pick<OrchestrationV2ThreadProjection, "providerSessions" | "thread">,
): number | undefined => {
  const session = projection.providerSessions.at(-1);
  if (session === undefined) return toMillis(projection.thread.updatedAt);
  if (session.status !== "stopped" && session.status !== "error") return undefined;
  return Math.max(toMillis(session.updatedAt), toMillis(projection.thread.updatedAt));
};

/** The CLI prints UTC without saying so. */
export const sandboxCreatedAt = ({ createdAt }: OpenShellSandboxSummary): number =>
  Date.parse(`${createdAt.replace(" ", "T")}Z`);

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const platform = yield* HostProcess.Platform;

  const check = Effect.fn("OpenShellIdleSandboxStopper.check")(function* () {
    const settings = yield* serverSettings.getSettings;
    const idleMs = settings.openShellIdleStopMinutes * 60_000;
    const profile = firstProfile(settings.providerInstances);
    if (idleMs === 0 || profile === undefined) return;
    const sandboxes = yield* Effect.promise(() => listSandboxes(profile, platform));
    const running = sandboxes.filter(({ phase }) => phase === READY_PHASE);
    if (running.length === 0) return;
    const threads = yield* orchestrator.listActiveShellIndex();
    const now = yield* Clock.currentTimeMillis;
    for (const sandbox of running) {
      const target = { ...profile, sandbox: sandbox.name, workdir: `/sandbox/${sandbox.name}` };
      const thread = threads.find(
        ({ id }) => targetForThread(profile, id).sandbox === sandbox.name,
      );
      // An archived or deleted thread is not in the index, and nothing can be running for it.
      const lastActivity =
        thread === undefined
          ? sandboxCreatedAt(sandbox)
          : lastActivityOfThread(yield* orchestrator.getThreadProjection(thread.id));
      if (lastActivity === undefined || now - lastActivity < idleMs) continue;
      yield* Effect.promise(() => controlSandbox(target, "stop", platform));
      yield* Effect.logInfo("stopped idle sandbox", { sandbox: sandbox.name });
    }
  });

  const start = Effect.fn("OpenShellIdleSandboxStopper.start")(function* () {
    yield* forkParked(
      check().pipe(
        Effect.catchCause((cause) => Effect.logWarning("idle sandbox check failed", { cause })),
        Effect.andThen(Effect.sleep(CHECK_INTERVAL)),
        Effect.forever,
      ),
    );
  });
  return { start };
});
