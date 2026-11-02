// Which number an account's quota bars show when its sources disagree.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers";
import { fake, resetFake } from "./fake/herdr.mjs";

const { ACCOUNTS, API_QUOTAS, currentWindow } = await import("../accounts.js");
const NOW = Date.now() / 1000, SOON = NOW + 3600, LATER = NOW + 7200, GONE = NOW - 60;
const key = ACCOUNTS[0].key, FILE = `/home/test/.cache/herdr-relevo/quota-${key}.json`;
const window = (used_percentage, resets_at) => ({ used_percentage, resets_at });
const snapshot = (rate_limits, updated = NOW) => JSON.stringify({ updated, rate_limits });

// What's remembered lives in the module, so each test loads its own.
let copies = 0, loadClaudeQuotas;
const quota = async () => (await loadClaudeQuotas())[key];

beforeEach(async () => {
  resetFake();
  ({ loadClaudeQuotas } = await import(`../accounts.js?copy=${++copies}`));
});

test("currentWindow: the highest value that hasn't expired", () => {
  assert.equal(currentWindow([window(38, SOON), window(76, SOON), undefined], NOW).used_percentage, 76);
  assert.equal(currentWindow([window(98, GONE), window(5, LATER)], NOW).used_percentage, 5);
  assert.equal(currentWindow([window(40, null), window(10, SOON)], NOW).used_percentage, 40);
  assert.equal(currentWindow([window(98, GONE)], NOW).resets_at, GONE);
  assert.equal(currentWindow([undefined, null], NOW), undefined);
});

test("an idle session's newer snapshot can't lower a bar or empty it", async () => {
  fake.files[FILE] = snapshot({ five_hour: window(38, SOON), seven_day: window(85, LATER) });
  assert.equal((await quota()).d7.pct, 85);
  fake.files[FILE] = snapshot({ seven_day: window(77, LATER) }, NOW + 15);
  const q = await quota();
  assert.equal(q.d7.pct, 85);
  assert.equal(q.h5.pct, 38);
});

test("a lower usage endpoint doesn't hide a higher snapshot, and each window is taken alone", async () => {
  fake.files[FILE] = snapshot({ five_hour: window(90, SOON), seven_day: window(20, LATER) });
  fake.stored[API_QUOTAS] = { [key]: { updated: NOW + 30, rate_limits: { five_hour: window(60, SOON), seven_day: window(50, LATER) } } };
  const q = await quota();
  assert.equal(q.h5.pct, 90);
  assert.equal(q.d7.pct, 50);
});

test("a window that ended shows the new one's usage", async () => {
  fake.files[FILE] = snapshot({ five_hour: window(99, Date.now() / 1000 + 0.02) });
  assert.equal((await quota()).h5.pct, 99);
  await new Promise((resolve) => setTimeout(resolve, 40));
  fake.files[FILE] = snapshot({ five_hour: window(3, LATER) });
  assert.equal((await quota()).h5.pct, 3);
});

test("an account with nothing known stays empty", async () => {
  assert.equal((await loadClaudeQuotas())["no-such-account"], undefined);
  assert.equal((await loadClaudeQuotas()).codex, null);
});
