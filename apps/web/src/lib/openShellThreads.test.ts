import { OPENSHELL_SANDBOX_AUTH_TYPE, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { firstSandboxModelSelection } from "./openShellThreads";

const provider = (instanceId: string, authType: string, enabled = true) =>
  ({
    instanceId,
    enabled,
    auth: { status: "authenticated", type: authType },
    models: [{ slug: "small" }, { slug: "large", isDefault: true }],
  }) as unknown as ServerProvider;

describe("firstSandboxModelSelection", () => {
  it("picks the default model of the first enabled sandbox template", () => {
    expect(
      firstSandboxModelSelection([
        provider("claude", "subscription"),
        provider("off", OPENSHELL_SANDBOX_AUTH_TYPE, false),
        provider("openshell", OPENSHELL_SANDBOX_AUTH_TYPE),
      ]),
    ).toEqual({ instanceId: "openshell", model: "large" });
  });

  it("returns nothing on a machine without a template", () => {
    expect(firstSandboxModelSelection([provider("claude", "subscription")])).toBeNull();
  });
});
