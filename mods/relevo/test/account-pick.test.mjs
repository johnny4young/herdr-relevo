// Which account a PR skill starts on: the repo's, unless it is nearly out of quota.
import "./fake/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { pickAccount, NEAR_FULL } = await import("../accounts.js");
const { accountFor } = await import("../context.js");
const { FALLBACK } = await import("../config.js");

const repo = "someone/app", own = accountFor(repo), other = FALLBACK.find((k) => k !== own);
const q = (h5, d7 = 0) => ({ h5: { pct: h5 }, d7: { pct: d7, resets: Date.now() / 1000 + 86400 } });

test("the repo's own account until it is nearly full", () => {
  assert.deepEqual(pickAccount(repo, { [own]: q(NEAR_FULL - 1) }), { key: own, note: null });
  assert.deepEqual(pickAccount(repo, {}), { key: own, note: null });
});

test("at 98% it moves to the account with the most left, and says why", () => {
  const pick = pickAccount(repo, { [own]: q(98), [other]: q(20) });
  assert.equal(pick.key, other);
  assert.match(pick.note, /is at 98% \(5h\) — using/);
  assert.equal(pickAccount(repo, { [own]: q(10, 95), [other]: q(5) }).key, other, "the weekly window counts too");
});

test("with every other account nearly full too, it stays", () => {
  assert.equal(pickAccount(repo, { [own]: q(98), [other]: q(93) }).key, own);
});
