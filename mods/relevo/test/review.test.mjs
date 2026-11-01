// Review comments: ranges, whole-file notes and the message sent to the agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffRows, selectRange, lineComment, fileComment, commentId, rangeRows, formatComment, reviewMessage,
} from "../lib/diff.js";

const rows = diffRows([
  "@@ -10,4 +10,5 @@", " keep", "-old one", "+new one", "+new two", " tail",
  "@@ -40,1 +41,1 @@", "-gone", "+here",
]);

test("selectRange: either order, hunk headers trimmed from the ends", () => {
  assert.deepEqual(selectRange(rows, 4, 1), { start: 1, end: 4 });
  assert.deepEqual(selectRange(rows, 0, 2), { start: 1, end: 2 });
  assert.deepEqual(selectRange(rows, 5, 6), { start: 5, end: 5 });
  assert.equal(selectRange(rows, 6, 6), null);
});

test("lineComment: one line keeps the original shape", () => {
  assert.deepEqual(lineComment("a.ts", rows, 3, 3, "why"), {
    file: "a.ts", key: "+11", line: 11, side: "+", code: "new one", text: "why",
  });
});

test("lineComment: a range is keyed by its last line and remembers both ends", () => {
  const c = lineComment("a.ts", rows, 1, 5, "tidy");
  assert.equal(c.key, "+13");
  assert.equal(c.start, "+10");
  assert.deepEqual([c.line, c.end, c.code, c.endCode, c.count], [10, 13, "keep", "tail", 5]);
  assert.equal(commentId(c), "+10..+13");
});

test("commentId: a line, a range ending on it and the file are separate targets", () => {
  const old = { file: "a.ts", key: "+13", line: 13, side: " ", code: "tail", text: "x" };
  assert.equal(commentId(old), "+13");
  assert.notEqual(commentId(lineComment("a.ts", rows, 1, 5, "y")), commentId(old));
  assert.equal(commentId(fileComment("a.ts", "z")), "file");
});

test("rangeRows: saved ranges tint every row they cover, single lines none", () => {
  const marked = rangeRows(rows, [lineComment("a.ts", rows, 2, 4, "r"), lineComment("a.ts", rows, 7, 7, "l")]);
  assert.deepEqual([...marked], [2, 3, 4]);
  assert.equal(rangeRows(rows, [{ file: "a.ts", key: "+99", start: "+1", text: "stale" }]).size, 0);
});

test("formatComment: old single-line comments send as before", () => {
  const old = { file: "a.ts", key: "-40", line: 40, side: "-", code: "gone", text: "keep it" };
  assert.equal(formatComment(old, 1), "1. a.ts:40 (removed line)\n   > gone\n   keep it");
});

test("formatComment: ranges quote both ends, files say so", () => {
  assert.equal(formatComment(lineComment("a.ts", rows, 1, 5, "tidy"), 2),
    "2. a.ts:10-13\n   > keep\n   > …\n   > tail\n   tidy");
  assert.equal(formatComment(lineComment("a.ts", rows, 3, 4, "pair"), 1),
    "1. a.ts:11-12\n   > new one\n   > new two\n   pair");
  assert.equal(formatComment(fileComment("a.ts", "split it"), 3), "3. a.ts (whole file)\n   split it");
});

test("reviewMessage: numbered in order after the instruction", () => {
  const msg = reviewMessage([fileComment("a.ts", "one"), lineComment("b.ts", rows, 3, 3, "two")]);
  assert.match(msg, /^Review comments on the uncommitted changes\./);
  assert.match(msg, /\n\n1\. a\.ts \(whole file\)\n {3}one\n\n2\. b\.ts:11\n/);
});
