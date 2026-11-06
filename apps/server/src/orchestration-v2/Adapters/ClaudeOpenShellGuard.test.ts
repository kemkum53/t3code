import { assert, describe, it } from "@effect/vitest";

import {
  assertSandboxName,
  mergeAccessRequests,
  parseAccessRequests,
  parseDenials,
  parseFileDenials,
  parseFileRequests,
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

describe("mergeAccessRequests", () => {
  const denial = { binary: "/usr/bin/curl", host: "example.com", port: 443, count: 1 };
  const chunk = { chunkId: "a", binary: denial.binary, host: denial.host, port: denial.port };

  it("shows a denial before the gateway has a draft for it", () => {
    assert.deepStrictEqual(mergeAccessRequests("t3-a", [denial], [], []), [
      { chunkId: null, binary: denial.binary, host: denial.host, port: 443 },
    ]);
  });

  it("joins a denial with its draft instead of listing both", () => {
    assert.deepStrictEqual(
      mergeAccessRequests("t3-a", [denial], [chunk], []).map(({ chunkId }) => chunkId),
      ["a"],
    );
  });

  it("drops a request once a rule covers it", () => {
    const rule = {
      name: "t3_user_curl",
      host: denial.host,
      port: 443,
      binaries: [denial.binary],
      managed: false,
    };
    assert.deepStrictEqual(mergeAccessRequests("t3-a", [denial], [chunk], [rule]), []);
  });
});

describe("parseFileDenials", () => {
  const now = Date.parse("2026-11-06T08:20:00Z");
  const item = (output: string, startedAt = "2026-11-06T08:13:54Z") => ({
    type: "command_execution",
    input: "ls -la /",
    output,
    startedAt,
  });

  it("reports the denied command with its message", () => {
    assert.deepStrictEqual(
      parseFileDenials(
        [item("Error: Exit code 2\nls: cannot open directory '/': Permission denied")],
        now,
      ),
      [{ command: "ls -la /", message: "ls: cannot open directory '/': Permission denied" }],
    );
  });

  it("skips clean output and old attempts", () => {
    assert.deepStrictEqual(
      parseFileDenials(
        [item("ok"), item("touch: x: Permission denied", "2026-11-06T07:00:00Z")],
        now,
      ),
      [],
    );
  });
});

describe("parseFileRequests", () => {
  const denial = (command: string, message: string) => ({ command, message });

  it("offers a path outside the rules", () => {
    assert.deepStrictEqual(
      parseFileRequests(
        "t3-a",
        [
          denial("ls -la /", "ls: cannot open directory '/': Permission denied"),
          denial("cat /root/x", "cat: /root/x: Permission denied"),
        ],
        ["/usr", "/sandbox"],
      ),
      [
        { path: "/", program: "ls" },
        { path: "/root/x", program: "cat" },
      ],
    );
  });

  it("skips writes to a path that is already readable", () => {
    assert.deepStrictEqual(
      parseFileRequests(
        "t3-a",
        [denial("touch /etc/x", "touch: cannot touch '/etc/x': Permission denied")],
        ["/etc"],
      ),
      [],
    );
  });
});

describe("parseAccessRequests", () => {
  it("reads pending requests and skips telemetry", () => {
    const output = [
      "Network Rules:  (version 1, 2 chunks)",
      "",
      "  Chunk: 306ef510-4483-42a0-9c77-6a3ddf2827ea",
      "  Status: pending",
      "  Rule: allow_example_com_443",
      "  Binary: /usr/bin/curl",
      "  Prover: prover: no new findings",
      "  Endpoints: example.com:443 [L4]",
      "",
      "  Chunk: 406ef510-4483-42a0-9c77-6a3ddf2827ea",
      "  Status: pending",
      "  Binary: /usr/local/bin/claude",
      "  Endpoints: http-intake.logs.us5.datadoghq.com:443 [L4]",
    ].join("\n");
    assert.deepStrictEqual(parseAccessRequests(output), [
      {
        chunkId: "306ef510-4483-42a0-9c77-6a3ddf2827ea",
        binary: "/usr/bin/curl",
        host: "example.com",
        port: 443,
      },
    ]);
  });

  it("returns nothing when no rule is pending", () => {
    assert.deepStrictEqual(parseAccessRequests("No network rules for sandbox 'x'"), []);
  });
});
