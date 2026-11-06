import { assert, describe, it } from "@effect/vitest";

import {
  firstClaudeBinaryPath,
  assertPackages,
  isTemplateImage,
  listTemplates,
  newTemplate,
  setupFailureMessage,
  setupScript,
  setupTemplates,
  templateDisplayName,
  templateId,
  templateImagePath,
  templatePolicy,
  withTemplateChanges,
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

describe("templateId", () => {
  it("makes a slug and avoids taken ids", () => {
    assert.strictEqual(templateId("OpenShell Python", []), "openshell_python");
    assert.strictEqual(
      templateId("Python", ["openshell_python", "openshell_python_2"]),
      "openshell_python_3",
    );
  });

  it("survives a name with no latin letters", () => {
    assert.strictEqual(templateId("şğü", []), "openshell_custom");
  });
});

describe("templateDisplayName", () => {
  it("adds the prefix once", () => {
    assert.strictEqual(templateDisplayName("Python"), "OpenShell Python");
    assert.strictEqual(templateDisplayName("OpenShell Node"), "OpenShell Node");
  });
});

describe("listTemplates", () => {
  const python = newTemplate({
    id: "openshell_python",
    name: "Python",
    packages: "python3",
    hosts: "pypi.org",
    distro: undefined,
    binaryPath: undefined,
  });

  it("reads back what was saved and skips other providers", () => {
    assert.deepStrictEqual(
      listTemplates({ openshell_python: python, codex: { driver: "codex" } as never }, "fallback"),
      [
        {
          id: "openshell_python",
          name: "OpenShell Python",
          packages: "python3",
          hosts: "pypi.org",
        },
      ],
    );
  });

  it("falls back for a template made before packages were stored", () => {
    const [[, instance]] = setupTemplates(undefined, undefined);
    assert.strictEqual(listTemplates({ a: instance }, "fallback")[0]?.packages, "fallback");
  });

  it("points a rebuilt template at its own image", () => {
    const [[, shared]] = setupTemplates(undefined, undefined);
    const rebuilt = withTemplateChanges(shared, {
      id: "openshell",
      packages: "nodejs",
      hosts: "",
      rebuilt: true,
    });
    const image = rebuilt.environment?.find(({ name }) => name === "T3_OPENSHELL_IMAGE");
    assert.strictEqual(image?.value, templateImagePath("openshell"));
    assert.isTrue(isTemplateImage(templateImagePath("openshell")));
  });
});

describe("templatePolicy", () => {
  it("adds the hosts for everything except Claude", () => {
    const policy = templatePolicy("pypi.org example.com:8443");
    assert.include(policy, '{ host: "pypi.org", port: 443 }');
    assert.include(policy, '{ host: "example.com", port: 8443 }');
    assert.notInclude(policy, "- path: /usr/local/bin/*");
  });

  it("keeps Claude only when there are no hosts", () => {
    assert.notInclude(templatePolicy("  "), "t3_user_hosts");
  });

  it("refuses text that could break the file", () => {
    assert.throws(() => templatePolicy('x.com" }'));
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
