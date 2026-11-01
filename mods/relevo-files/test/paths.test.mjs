// From this folder: node --test 'test/*.test.mjs'.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nameError, parentOf, baseName, join, targetFolder, moved, isUnder, textState, languageOf, PREVIEW_LIMIT, READ_LIMIT } from "../lib/paths.js";

test("nameError: rejects empty, dot names, slashes and padding", () => {
  assert.equal(nameError("notes.md"), null);
  assert.equal(nameError(".env"), null);
  for (const bad of ["", ".", "..", "a/b", "a\0b", " a", "a "]) assert.ok(nameError(bad), bad);
});

test("parentOf, baseName and join on relative paths", () => {
  assert.equal(parentOf("a/b/c.js"), "a/b");
  assert.equal(parentOf("c.js"), "");
  assert.equal(baseName("a/b/c.js"), "c.js");
  assert.equal(join("", "c.js"), "c.js");
  assert.equal(join("/r", "a", "c.js"), "/r/a/c.js");
});

test("targetFolder: inside a folder, beside a file, the root for the root", () => {
  assert.equal(targetFolder({ path: "src", dir: true }), "src");
  assert.equal(targetFolder({ path: "src/a.js", dir: false }), "src");
  assert.equal(targetFolder({ path: "a.js", dir: false }), "");
  assert.equal(targetFolder({ path: "", dir: true }), "");
});

test("moved and isUnder follow a rename without matching name prefixes", () => {
  assert.equal(moved("src", "src", "lib"), "lib");
  assert.equal(moved("src/a/b.js", "src", "lib"), "lib/a/b.js");
  assert.equal(moved("srcx/b.js", "src", "lib"), "srcx/b.js");
  assert.ok(isUnder("src/a.js", "src"));
  assert.ok(!isUnder("srcx", "src"));
  assert.ok(!isUnder(null, "src"));
});

test("textState: only whole text files read in full are editable", () => {
  assert.deepEqual(textState("hi", 2), { value: "hi", editable: true });
  assert.equal(textState("hi", null).editable, false);
  assert.equal(textState("x".repeat(10), READ_LIMIT).editable, false);
  assert.ok(textState(null, null).error);
  assert.ok(textState("a\0b", 3).error);
  const big = textState("x".repeat(PREVIEW_LIMIT + 1), PREVIEW_LIMIT + 1);
  assert.equal(big.editable, false);
  assert.ok(big.value.endsWith("(file truncated)"));
});

test("languageOf maps script extensions and falls back to txt", () => {
  assert.equal(languageOf("a/b.tsx"), "js");
  assert.equal(languageOf("README.md"), "md");
  assert.equal(languageOf("Makefile"), "txt");
});
