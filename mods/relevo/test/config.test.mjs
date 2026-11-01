import { test } from "node:test";
import assert from "node:assert/strict";
import * as mine from "../config.js";
import * as example from "../config.example.js";

// Both files must describe a setup the mod can run, so the example never falls behind.
for (const [name, c] of [["config.js", mine], ["config.example.js", example]]) {
  test(`${name}: a complete, consistent setup`, () => {
    assert.deepEqual(Object.keys(c).sort(), Object.keys(example).sort());
    const keys = new Set(c.ACCOUNTS.map((a) => a.key));
    for (const a of [...c.ACCOUNTS, c.CODEX]) {
      for (const field of ["key", "label", "letter", "launcher", "bg", "fg"]) assert.ok(a[field], `${a.key ?? "?"}.${field}`);
    }
    for (const a of c.ACCOUNTS) assert.ok(a.claudeDir, `${a.key}.claudeDir`);
    assert.equal(keys.size, c.ACCOUNTS.length, "account keys are unique");
    assert.ok(!c.CONTEXTS[0].orgs?.length, "the first context is the default and claims no orgs");
    for (const ctx of c.CONTEXTS) assert.ok(keys.has(ctx.account), `context ${ctx.key} uses a known account`);
    for (const k of c.FALLBACK) assert.ok(keys.has(k), `fallback ${k} is a known account`);
    assert.ok(c.REPOS_ROOT && !c.REPOS_ROOT.startsWith("/"), "REPOS_ROOT is relative to home");
    assert.deepEqual(Object.keys(c.SKILLS).sort(), ["comments", "fix", "review"]);
  });
}
