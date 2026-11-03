import { test } from "node:test";
import assert from "node:assert/strict";
import { historySuggestions, recordUse, rankReplies, usageScore, HALF_LIFE } from "../lib/replies.js";

const NOW = Date.parse("2026-11-03T12:00:00Z"), DAY = 86400e3;
const line = (display, daysAgo, project = "/p/app") => JSON.stringify({ display, timestamp: NOW - daysAgo * DAY, project });
const lines = (...l) => l.join("\n");
const all = () => true;

test("historySuggestions: three uses in 90 days, recent ones weigh more, newest spelling wins", () => {
  const text = lines(
    line("haz commit y push", 1), line("Haz commit  y push.", 2), line("haz Commit y push", 3),
    line("corre los tests", 40), line("corre los tests", 41), line("corre los tests", 42),
    line("old phrase here", 100), line("old phrase here", 101), line("old phrase here", 1),
    line("only twice", 1), line("only twice", 2),
  );
  const got = historySuggestions(text, NOW, all);
  assert.deepEqual(got.map((s) => [s.text, s.uses]), [["haz commit y push", 3], ["corre los tests", 3]]);
  assert.ok(got[0].score > got[1].score);
});

test("historySuggestions: commands, pastes, images, menu answers, long or broken lines and other folders don't count", () => {
  const thrice = (t, project) => [line(t, 1, project), line(t, 2, project), line(t, 3, project)];
  const text = lines(...thrice("/review-pr 12"), ...thrice("!git pull"), ...thrice("[Pasted text #1 +5 lines]"),
    ...thrice("[Image #2]"), ...thrice("si"), ...thrice("x".repeat(81)), ...thrice("two\nlines here"),
    ...thrice("from the other place", "/w/acme-api"), "not json", ...thrice("keep this one"));
  const keep = (project) => !project.includes("acme");
  assert.deepEqual(historySuggestions(text, NOW, keep).map((s) => s.text), ["keep this one"]);
});

test("recordUse: adds one, decays the rest and drops what no longer counts", () => {
  const usage = { "a": { score: 2, at: NOW - HALF_LIFE }, "gone": { score: 0.01, at: NOW } };
  const next = recordUse(usage, " A ", NOW);
  assert.equal(next.a.score, 2);
  assert.equal(next.gone, undefined);
  assert.equal(usageScore(next.a, NOW + HALF_LIFE), 1);
});

test("rankReplies: saved by use, ties in saved order, then new suggestions up to five", () => {
  const saved = ["Continue", "Commit and push", "Fix it"];
  const usage = { "commit and push": { score: 3, at: NOW } };
  const history = [{ text: "commit and push", uses: 9 }, { text: "run the tests", uses: 4 }, { text: "open the PR", uses: 3 },
    { text: "one too many", uses: 3 }];
  assert.deepEqual(rankReplies(saved, usage, history, NOW), [
    { text: "Commit and push" }, { text: "Continue" }, { text: "Fix it" },
    { text: "run the tests", uses: 4 }, { text: "open the PR", uses: 3 },
  ]);
  const many = ["1", "2", "3", "4", "5", "6"];
  assert.deepEqual(rankReplies(many, {}, history, NOW).map((r) => r.text), many);
});
