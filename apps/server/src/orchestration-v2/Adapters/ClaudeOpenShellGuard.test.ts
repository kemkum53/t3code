import { assert, describe, it } from "@effect/vitest";

import {
  assertSandboxName,
  parseDenials,
  parseHostChecks,
  parseRules,
  parseSandboxList,
} from "./ClaudeOpenShellGuard.ts";

describe("parseDenials", () => {
  it("groups repeats and skips expected telemetry", () => {
    const logs = [
      "[1] NET:OPEN [MED] DENIED /usr/bin/curl(0) -> github.com:443 [reason:x]",
      "[2] NET:OPEN [MED] DENIED /usr/bin/curl(12) -> github.com:443 [reason:x]",
      "[3] NET:OPEN [MED] DENIED /usr/local/bin/claude(0) -> http-intake.logs.us5.datadoghq.com:443 [reason:x]",
      "[4] NET:REFUSE [MED] DENIED example.com [reason:policy_dns_ineligible]",
    ].join("\n");
    assert.deepStrictEqual(parseDenials(logs), [
      { binary: "/usr/bin/curl", host: "github.com", port: 443, count: 2 },
    ]);
  });
});

describe("parseRules", () => {
  it("marks only the user's rules as editable", () => {
    const rules = parseRules({
      claude_api: {
        binaries: [{ path: "/usr/local/bin/claude" }],
        endpoints: [{ host: "api.anthropic.com", port: 443 }],
      },
      t3_user_curl: {
        binaries: [{ path: "/usr/bin/curl" }],
        endpoints: [{ host: "registry.npmjs.org", port: 443 }],
      },
    });
    assert.deepStrictEqual(
      rules.map((rule) => [rule.host, rule.managed]),
      [
        ["api.anthropic.com", true],
        ["registry.npmjs.org", false],
      ],
    );
  });
});

describe("parseSandboxList", () => {
  it("keeps name, phase and creation time", () => {
    assert.deepStrictEqual(
      parseSandboxList(
        JSON.stringify({
          sandboxes: [{ name: "t3-a", phase: "Ready", created_at: "2026-11-05", id: "1" }],
        }),
      ),
      [{ name: "t3-a", phase: "Ready", createdAt: "2026-11-05" }],
    );
  });
});

describe("parseHostChecks", () => {
  it("keeps values that contain an equals sign", () => {
    assert.deepStrictEqual(parseHostChecks("version=openshell 0.1.7\nnoise\nkey=a=b\n"), {
      version: "openshell 0.1.7",
      key: "a=b",
    });
  });
});

describe("assertSandboxName", () => {
  it("accepts generated names and refuses anything else", () => {
    assert.strictEqual(assertSandboxName("t3-abc123"), "t3-abc123");
    assert.throws(() => assertSandboxName("t3-abc; rm -rf /"));
    assert.throws(() => assertSandboxName("homeassistant"));
  });
});
