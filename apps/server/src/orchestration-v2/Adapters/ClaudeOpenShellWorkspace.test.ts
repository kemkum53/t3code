import { assert, describe, it } from "@effect/vitest";

import { parseNumstat, quoteForShell } from "./ClaudeOpenShellWorkspace.ts";

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
