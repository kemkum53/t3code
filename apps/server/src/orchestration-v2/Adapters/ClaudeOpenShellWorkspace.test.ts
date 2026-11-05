import { assert, describe, it } from "@effect/vitest";

import { parseNumstat, parseSandboxEntries, quoteForShell } from "./ClaudeOpenShellWorkspace.ts";

describe("parseNumstat", () => {
  it("reads text and binary rows", () => {
    assert.deepStrictEqual(parseNumstat("2\t1\tsrc/a b.ts\n-\t-\tasset.bin\n"), [
      { path: "src/a b.ts", additions: 2, deletions: 1 },
      { path: "asset.bin", additions: null, deletions: null },
    ]);
  });

  it("returns nothing for an empty diff", () => {
    assert.deepStrictEqual(parseNumstat(""), []);
  });
});

describe("quoteForShell", () => {
  it("survives a single quote", () => {
    assert.strictEqual(quoteForShell("it's"), String.raw`'it'\''s'`);
  });
});

describe("parseSandboxEntries", () => {
  it("keeps paths relative to the workdir", () => {
    assert.deepStrictEqual(parseSandboxEntries("d\tapps\nf\tREADME.md\n", ""), [
      { path: "apps", kind: "directory" },
      { path: "README.md", kind: "file" },
    ]);
    assert.deepStrictEqual(parseSandboxEntries("f\tmain.py\n", "apps/hub"), [
      { path: "apps/hub/main.py", kind: "file" },
    ]);
  });
});
