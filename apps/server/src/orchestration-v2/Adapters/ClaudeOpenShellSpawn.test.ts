import { describe, expect, it } from "@effect/vitest";

import {
  buildOpenShellCommand,
  forwardedEnvironment,
  resolveOpenShellTarget,
} from "./ClaudeOpenShellSpawn.ts";

const target = {
  sandbox: "box",
  workdir: "/sandbox/app",
  wslDistro: "Ubuntu-24.04",
  image: "img",
  policy: undefined,
  provider: undefined,
};

describe("resolveOpenShellTarget", () => {
  it("returns undefined without an image", () => {
    expect(resolveOpenShellTarget({}, "thread")).toBeUndefined();
    expect(resolveOpenShellTarget({ T3_OPENSHELL_IMAGE: "  " }, "thread")).toBeUndefined();
  });

  it("derives a stable box from the thread", () => {
    const target = resolveOpenShellTarget(
      { T3_OPENSHELL_IMAGE: "img", T3_OPENSHELL_PROVIDER: "sub" },
      "5D465468-932f-4962",
    );
    expect(target?.sandbox).toBe("t3-5d465468932f");
    expect(target?.workdir).toBe("/sandbox/t3-5d465468932f");
    expect(target?.provider).toBe("sub");
  });
});

describe("forwardedEnvironment", () => {
  it("keeps credentials and host paths out of the sandbox", () => {
    expect(
      forwardedEnvironment({
        ANTHROPIC_API_KEY: "secret",
        ANTHROPIC_AUTH_TOKEN: "secret",
        CLAUDE_CODE_OAUTH_TOKEN: "secret",
        CLAUDE_CONFIG_DIR: "C:/Users/me/.claude",
        PATH: "C:/Windows",
        CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
        MAX_THINKING_TOKENS: "1000",
      }),
    ).toEqual(["CLAUDE_CODE_ENTRYPOINT=sdk-ts", "MAX_THINKING_TOKENS=1000"]);
  });
});

describe("buildOpenShellCommand", () => {
  it("runs openshell directly on Linux", () => {
    const { command, args } = buildOpenShellCommand(target, ["--print"], {}, "linux");
    expect(command).toBe("openshell");
    expect(args.slice(-3)).toEqual(["--", "/usr/local/bin/claude", "--print"]);
  });

  it("goes through the WSL distro on Windows", () => {
    const { command, args } = buildOpenShellCommand(target, ["--print"], {}, "win32");
    expect(command).toBe("wsl.exe");
    expect(args.slice(0, 6)).toEqual(["-d", "Ubuntu-24.04", "--cd", "~", "-e", "openshell"]);
  });
});
