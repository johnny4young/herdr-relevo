// Syntax colors in the review pane's diff lines.
import "./fake/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeCx } from "./fake/ui.mjs";
import { diffRows } from "../lib/diff.js";
import { highlightRows, languageFor, tokenize } from "../lib/highlight.js";

const { ReviewDiff } = await import("../review.js");
const kinds = (tokens) => tokens.filter(([k]) => k).map(([k, s]) => `${k}:${s}`);

test("a line splits into keywords, strings, numbers, calls, types and comments", () => {
  assert.deepEqual(kinds(tokenize(`  const url = new URL("http://x", 8080); // why`, "js")),
    ["keyword:const", "keyword:new", "function:URL", "string:\"http://x\"", "number:8080", "comment:// why"]);
  assert.deepEqual(kinds(tokenize("func (s *Server) Run() error { return nil }", "go")),
    ["keyword:func", "type:Server", "function:Run", "keyword:return", "constant:nil"]);
  assert.deepEqual(kinds(tokenize(`echo "$#" # note`, "sh")), ["string:\"$#\"", "comment:# note"]);
  assert.equal(tokenize(`  if (x) return;`, "js").map(([, s]) => s).join(""), "  if (x) return;", "every character is kept, indentation too");
});

test("a block comment carries to the next lines until it ends, and a hunk starts over", () => {
  const rows = highlightRows(diffRows(["@@ -1,3 +1,3 @@", " /* one", "+two", " three */ let x = 1", "@@ -9,1 +9,1 @@", " two"]), "js");
  assert.deepEqual(rows.slice(1, 4).map((r) => r.tokens[0][0]), ["comment", "comment", "comment"]);
  assert.deepEqual(kinds(rows[3].tokens), ["comment:three */", "keyword:let", "number:1"]);
  assert.deepEqual(rows[5].tokens, [[null, "two"]]);
});

test("unknown files and very long lines stay plain", () => {
  assert.equal(languageFor("README.md"), null);
  assert.equal(languageFor("ui/app.tsx"), "js");
  assert.equal(languageFor("Sources/App/View.swift"), "swift");
  assert.equal(highlightRows(diffRows(["@@ -1 +1 @@", "+# Title"]), null)[1].tokens, undefined);
  assert.equal(tokenize(`const a = "${"x".repeat(500)}"`, "js"), null);
});

test("the pane colors each run and keeps the added line's tint", () => {
  const v = new ReviewDiff();
  v.init({}, fakeCx());
  const t = { ansi1: "#f00", ansi2: "#0f0", ansi3: "#ff0", ansi4: "#00f", ansi5: "#f0f", ansi6: "#0ff", dim: "#888", hover: "#111", accent: "#abc", selected: "#222" };
  const [, row] = highlightRows(diffRows(["@@ -1 +1 @@", "+return 1"]), "js");
  const el = v.row(t, row, 1, false, false);
  const code = el.items.at(-1);
  assert.deepEqual(code.items.map((s) => [s.ink, s.items[0]]), [["#f0f", "return"], [null, " "], ["#f00", "1"]]);
  assert.equal(el.fill, "#0f018");
});
