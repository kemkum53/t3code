import { OPENSHELL_SANDBOX_AUTH_TYPE, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sandboxStateOfPhase, sandboxTemplateChoices } from "./openShellThreads";

const provider = (instanceId: string, authType: string, enabled = true) =>
  ({
    instanceId,
    enabled,
    auth: { status: "authenticated", type: authType },
    models: [{ slug: "small" }, { slug: "large", isDefault: true }],
  }) as unknown as ServerProvider;

describe("sandboxTemplateChoices", () => {
  it("lists every enabled template with its default model", () => {
    expect(
      sandboxTemplateChoices([
        provider("claude", "subscription"),
        provider("off", OPENSHELL_SANDBOX_AUTH_TYPE, false),
        provider("openshell", OPENSHELL_SANDBOX_AUTH_TYPE),
      ]),
    ).toEqual([
      {
        name: "openshell",
        modelSelection: { instanceId: "openshell", model: "large" },
      },
    ]);
  });

  it("returns nothing on a machine without a template", () => {
    expect(sandboxTemplateChoices([provider("claude", "subscription")])).toEqual([]);
  });
});

describe("sandboxStateOfPhase", () => {
  it("maps OpenShell phases to what the chat shows", () => {
    expect(sandboxStateOfPhase("Ready")).toBe("running");
    expect(sandboxStateOfPhase("Stopped")).toBe("stopped");
    expect(sandboxStateOfPhase("Stopping")).toBe("stopped");
    expect(sandboxStateOfPhase("Provisioning")).toBe("starting");
    expect(sandboxStateOfPhase(null)).toBe("starting");
  });
});
