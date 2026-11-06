// Turn receipts, with the shell's extraction run for real on a fixture session and its subagents.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fake, resetFake } from "./fake/herdr.mjs";
import { flush } from "./fake/ui.mjs";
import { heavy, keepReceipts, receiptOf, turnRanges } from "../lib/turns.js";

const { TURNS, TurnWatch } = await import("../turns.js");

const line = (n, write, output = 10, ago = 0) => `${JSON.stringify({
  message: { model: "claude-x", id: `msg_${String(n).padStart(14, "0")}`, content: [], usage: {
    input_tokens: 0, cache_creation_input_tokens: write, cache_read_input_tokens: 0, output_tokens: output,
    cache_creation: { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 } } },
  requestId: `req_${n}`, type: "assistant", timestamp: new Date(Date.now() + ago * 1000).toISOString(), entrypoint: "cli", cwd: "/w/app", sessionId: "s1",
})}\n`;

let dir;
beforeEach(() => {
  resetFake();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "relevo-turns-"));
  fake.exec = (cmd, args) => {
    try {
      return { code: 0, stdout: execFileSync(cmd, args).toString() };
    } catch (e) {
      return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "" };
    }
  };
});

const settle = async () => {
  for (let i = 0; i < 20; i++) {
    await flush();
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("ranges run from each file's size at the start, new files from 0", () => {
  const before = new Map([["/a.jsonl", 100], ["/a/subagents/x.jsonl", 50]]);
  const now = new Map([["/a.jsonl", 300], ["/a/subagents/x.jsonl", 50], ["/a/subagents/y.jsonl", 80]]);
  assert.deepEqual(turnRanges(before, now).map((r) => [r.path, r.from, r.size]), [["/a.jsonl", 100, 300], ["/a/subagents/y.jsonl", 0, 80]]);
});

test("a receipt counts each message once and the subagents started in the turn", () => {
  const msg = (id, write) => ({ id, ts: "2026-11-05T12:00:00Z", model: "m", write, output: 1 });
  const r = receiptOf(new Map([["/s/subagents/old.jsonl", 10]]), [
    { path: "/s.jsonl", msgs: [msg("a", 100), msg("a", 100)] },
    { path: "/s/subagents/new.jsonl", msgs: [msg("b", 1000)] },
    { path: "/s/subagents/old.jsonl", msgs: [msg("c", 500)] },
  ]);
  assert.deepEqual(r, { write: 1600, output: 3, subs: 1, subWrite: 1500, subOutput: 2 });
});

test("only a turn of 5M or more is heavy, and receipts keep the newest 40", () => {
  assert.equal(heavy({ write: 4e6, output: 1e6 }), true);
  assert.equal(heavy({ write: 4e6, output: 0 }), false);
  const list = Array.from({ length: 45 }, (_, i) => ({ n: i })).reduce(keepReceipts, []);
  assert.deepEqual([list.length, list[0].n], [40, 44]);
});

test("an agent's turn, from working to done, gets a receipt and a heavy one an alert", async () => {
  const main = join(dir, "s1.jsonl"), subs = join(dir, "s1", "subagents");
  mkdirSync(subs, { recursive: true });
  writeFileSync(main, line(1, 999999, 10, -60));
  const watch = new TurnWatch(), labels = new Map([["t1", { "agent.transcript": main }]]);
  const agent = (status) => [{ address: "t1", status, tab_name: "fix" }];
  watch.agents(agent("working"), labels);
  await settle();
  appendFileSync(main, line(2, 1_000_000));
  writeFileSync(join(subs, "agent-a.jsonl"), line(3, 4_000_000) + line(4, 500_000));
  watch.agents(agent("blocked"), labels);
  await settle();
  assert.equal(fake.stored[TURNS], undefined);
  watch.agents(agent("done"), labels);
  await settle();
  const [r] = fake.stored[TURNS];
  assert.deepEqual([r.write, r.subs, r.subWrite, r.where, r.surface], [5_500_000, 1, 4_500_000, "fix", "terminal"]);
  assert.equal(fake.notices.at(-1).title, "fix · that turn took 5.5M");
  assert.equal(fake.notices.at(-1).body, "1 subagent: 4.5M · main conversation: 1.0M");
  assert.equal(readFileSync(main, "utf8").split("\n").length, 3);
});

test("a light turn gets a receipt without an alert", async () => {
  const main = join(dir, "s1.jsonl");
  writeFileSync(main, "");
  const watch = new TurnWatch(), labels = new Map([["t1", { "agent.transcript": main }]]);
  watch.agents([{ address: "t1", status: "working", tab_name: "fix" }], labels);
  await settle();
  appendFileSync(main, line(1, 2000));
  watch.agents([{ address: "t1", status: "idle", tab_name: "fix" }], labels);
  await settle();
  assert.equal(fake.stored[TURNS].length, 1);
  assert.equal(fake.notices.length, 0);
});

test("messages from before the turn don't count, though their block is read again", () => {
  const old = { id: "a", ts: "2026-11-05T11:00:00Z", model: "m", write: 9, output: 0 };
  const now = { id: "b", ts: "2026-11-05T12:00:00Z", model: "m", write: 5, output: 0 };
  assert.equal(receiptOf(new Map(), [{ path: "/s.jsonl", msgs: [old, now] }], Date.parse("2026-11-05T11:30:00Z") / 1000).write, 5);
});

test("a Desktop session that finished and left the list still gets its receipt", async () => {
  const main = join(dir, "d1.jsonl");
  writeFileSync(main, "");
  const watch = new TurnWatch();
  watch.transcriptOf = async () => main;
  await watch.desktop([{ id: "local_1", cli: "d1", state: "working", project: "app", title: "Fix" }]);
  await settle();
  appendFileSync(main, line(1, 3000));
  await watch.desktop([]);
  await settle();
  const [r] = fake.stored[TURNS];
  assert.deepEqual([r.where, r.surface, r.write], ["app · Fix", "desktop", 3000]);
});

test("an agent whose terminal closed mid-turn still gets its receipt", async () => {
  const main = join(dir, "s1.jsonl");
  writeFileSync(main, "");
  const watch = new TurnWatch(), labels = new Map([["t1", { "agent.transcript": main }]]);
  watch.agents([{ address: "t1", status: "working", tab_name: "fix" }], labels);
  await settle();
  appendFileSync(main, line(1, 2000));
  watch.agents([], labels);
  await settle();
  assert.equal(fake.stored[TURNS][0].where, "fix");
});
