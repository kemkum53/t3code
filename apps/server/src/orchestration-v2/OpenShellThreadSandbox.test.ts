import { assert, describe, it } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";

import {
  resolveSandboxForDeletedThread,
  resolveSandboxForPath,
  resolveThreadSandbox,
} from "./OpenShellThreadSandbox.ts";

type Input = Parameters<typeof resolveThreadSandbox>;

const threadId = "5d465468-932f-4962-96a9-ddb85c9cad5c" as ThreadId;
const session = {
  providerInstanceId: "box",
  cwd: "D:\\project",
} as unknown as Input[1]["providerSessions"][number];

const instances = (environment: ReadonlyArray<unknown>) =>
  ({ box: { driver: "claudeAgent", environment } }) as unknown as Input[2];

const configured = instances([
  { name: "T3_OPENSHELL_IMAGE", value: "$HOME/rootfs.tar", sensitive: false },
]);

describe("resolveThreadSandbox", () => {
  it("is undefined before the first session", () => {
    assert.isUndefined(resolveThreadSandbox(threadId, { providerSessions: [] }, configured));
  });

  it("is undefined for an instance without a profile", () => {
    assert.isUndefined(
      resolveThreadSandbox(threadId, { providerSessions: [session] }, instances([])),
    );
  });

  it("gives each thread its own box", () => {
    const sandbox = resolveThreadSandbox(threadId, { providerSessions: [session] }, configured);
    assert.strictEqual(sandbox?.target.sandbox, "t3-5d465468932f");
    assert.strictEqual(sandbox?.target.workdir, "/sandbox/t3-5d465468932f");
    assert.strictEqual(sandbox?.hostCwd, "D:\\project");
  });
});

describe("resolveSandboxForPath", () => {
  it("reads the box name from the path", () => {
    assert.strictEqual(
      resolveSandboxForPath("/sandbox/t3-abc123/src/a.txt", configured)?.sandbox,
      "t3-abc123",
    );
    assert.strictEqual(
      resolveSandboxForPath("/sandbox/t3-abc123", configured)?.sandbox,
      "t3-abc123",
    );
  });

  it("leaves host paths alone", () => {
    assert.isUndefined(resolveSandboxForPath("D:/project/a.txt", configured));
    assert.isUndefined(resolveSandboxForPath("/sandbox/other/a.txt", configured));
  });

  it("refuses to climb out of the workdir", () => {
    assert.isUndefined(resolveSandboxForPath("/sandbox/t3-abc123/../../etc/passwd", configured));
  });

  it("needs a configured profile", () => {
    assert.isUndefined(resolveSandboxForPath("/sandbox/t3-abc123/a.txt", instances([])));
  });
});

describe("resolveSandboxForDeletedThread", () => {
  it("finds the box without a session", () => {
    assert.strictEqual(
      resolveSandboxForDeletedThread(threadId, configured)?.sandbox,
      "t3-5d465468932f",
    );
  });

  it("does nothing when no profile is configured", () => {
    assert.isUndefined(resolveSandboxForDeletedThread(threadId, instances([])));
  });
});
