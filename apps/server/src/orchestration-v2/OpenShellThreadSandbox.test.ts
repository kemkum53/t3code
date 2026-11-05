import { assert, describe, it } from "@effect/vitest";

import { resolveThreadSandbox } from "./OpenShellThreadSandbox.ts";

type Input = Parameters<typeof resolveThreadSandbox>;

const session = {
  providerInstanceId: "box",
  cwd: "D:\\project",
} as unknown as Input[0]["providerSessions"][number];

const instances = (environment: ReadonlyArray<unknown>) =>
  ({ box: { driver: "claudeAgent", environment } }) as unknown as Input[1];

describe("resolveThreadSandbox", () => {
  it("is undefined before the first session", () => {
    assert.isUndefined(resolveThreadSandbox({ providerSessions: [] }, instances([])));
  });

  it("is undefined for an instance without a sandbox", () => {
    assert.isUndefined(resolveThreadSandbox({ providerSessions: [session] }, instances([])));
  });

  it("uses the session's host folder", () => {
    const sandbox = resolveThreadSandbox(
      { providerSessions: [session] },
      instances([{ name: "T3_OPENSHELL_SANDBOX", value: "s1", sensitive: false }]),
    );
    assert.strictEqual(sandbox?.target.sandbox, "s1");
    assert.strictEqual(sandbox?.hostCwd, "D:\\project");
  });
});
