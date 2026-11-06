import { assert, describe, it } from "@effect/vitest";

import {
  firstClaudeBinaryPath,
  assertPackages,
  setupFailureMessage,
  setupScript,
  setupTemplates,
} from "./ClaudeOpenShellSetup.ts";
import { parseDistroList } from "./ClaudeOpenShellWorkspace.ts";

const SETUP_SCRIPT = setupScript({ image: "$HOME/a.tar", packages: "python3", rebuildImage: true });

describe("assertPackages", () => {
  it("normalizes spacing and refuses shell syntax", () => {
    assert.strictEqual(assertPackages("  python3   nodejs "), "python3 nodejs");
    assert.throws(() => assertPackages("python3; rm -rf /"));
  });
});

describe("setupScript", () => {
  it("adds the chosen packages to the image", () => {
    assert.include(SETUP_SCRIPT, "ripgrep iproute2 python3 >/dev/null");
  });

  it("never puts the sudo password in an argument", () => {
    assert.include(SETUP_SCRIPT, `printf '%s\\n' "$SUDO_PASSWORD" | sudo -S`);
    assert.notInclude(SETUP_SCRIPT, "sudo $SUDO_PASSWORD");
  });

  it("verifies both downloads", () => {
    assert.strictEqual(SETUP_SCRIPT.split("sha256sum -c --quiet").length - 1, 2);
  });
});

describe("setupFailureMessage", () => {
  it("keeps the script's own last line", () => {
    const cause = new Error("wsl.exe exited 1: apt noise\nThe sudo password was refused.\n");
    assert.strictEqual(setupFailureMessage(cause), "The sudo password was refused.");
  });

  it("falls back when there is no detail", () => {
    assert.strictEqual(setupFailureMessage(undefined), "OpenShell setup failed");
  });
});

describe("setupTemplates", () => {
  it("names the distro only when there is one", () => {
    const names = (distro: string | undefined) =>
      (setupTemplates(distro, undefined)[0][1].environment ?? []).map(({ name }) => name);
    assert.include(names("Ubuntu-24.04"), "T3_OPENSHELL_WSL_DISTRO");
    assert.notInclude(names(undefined), "T3_OPENSHELL_WSL_DISTRO");
  });
});

describe("firstClaudeBinaryPath", () => {
  it("skips other drivers", () => {
    assert.strictEqual(
      firstClaudeBinaryPath({
        codex: { driver: "codex", config: { binaryPath: "codex" } },
        claude: { driver: "claudeAgent", config: { binaryPath: "/opt/claude" } },
      } as never),
      "/opt/claude",
    );
  });
});

describe("parseDistroList", () => {
  it("reads wsl.exe output and drops Docker's distros", () => {
    const listing = Buffer.from("docker-desktop\r\nUbuntu-24.04\r\n\r\n", "utf16le");
    assert.deepStrictEqual(parseDistroList(listing), ["Ubuntu-24.04"]);
  });
});
