import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { lastActivityOfThread, sandboxCreatedAt } from "./OpenShellIdleSandboxStopper.ts";

type Projection = Parameters<typeof lastActivityOfThread>[0];

const at = (value: string) => DateTime.makeUnsafe(value);

const projection = (status: string | undefined) =>
  ({
    thread: { updatedAt: at("2026-11-06T08:00:00Z") },
    providerSessions:
      status === undefined ? [] : [{ status, updatedAt: at("2026-11-06T08:30:00Z") }],
  }) as unknown as Projection;

describe("lastActivityOfThread", () => {
  it("keeps a box with a live session", () => {
    assert.isUndefined(lastActivityOfThread(projection("ready")));
    assert.isUndefined(lastActivityOfThread(projection("running")));
  });

  it("uses the latest time once the session ended", () => {
    assert.strictEqual(
      lastActivityOfThread(projection("stopped")),
      Date.parse("2026-11-06T08:30:00Z"),
    );
  });

  it("falls back to the thread when no session ever started", () => {
    assert.strictEqual(
      lastActivityOfThread(projection(undefined)),
      Date.parse("2026-11-06T08:00:00Z"),
    );
  });
});

describe("sandboxCreatedAt", () => {
  it("reads the CLI's time as UTC", () => {
    assert.strictEqual(
      sandboxCreatedAt({ name: "t3-a", phase: "Ready", createdAt: "2026-11-06 08:01:10" }),
      Date.parse("2026-11-06T08:01:10Z"),
    );
  });
});
