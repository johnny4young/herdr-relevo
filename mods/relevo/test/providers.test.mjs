// Which CLI an account runs and what it can do, before any feature asks.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as example from "../config.example.js";
import { PROVIDERS, providerOf, providerOfApp } from "../lib/providers.js";
import { handoffPlan, terminalAccount } from "../lib/handoff.js";
import { validate } from "../lib/settings.js";

const plain = (m) => JSON.parse(JSON.stringify({ ...m }));

test("an account without a provider is a Claude account", () => {
  assert.equal(providerOf({ key: "work", claudeDir: ".claude-work" }), PROVIDERS.claude);
  assert.equal(providerOf({ key: "x", provider: "codex" }), PROVIDERS.codex);
  assert.equal(providerOf({ key: "x", provider: "nope" }), PROVIDERS.claude);
  assert.equal(providerOf(null), PROVIDERS.claude);
});

test("Herdr's app names map to their provider", () => {
  assert.equal(providerOfApp("claude-code"), PROVIDERS.claude);
  assert.equal(providerOfApp("claude"), PROVIDERS.claude);
  assert.equal(providerOfApp("codex"), PROVIDERS.codex);
  assert.equal(providerOfApp("antigravity"), null);
  assert.equal(providerOfApp(null), null);
});

test("every provider declares the same capabilities and its efforts", () => {
  const caps = Object.keys(PROVIDERS.claude.caps).sort();
  for (const p of Object.values(PROVIDERS)) {
    assert.deepEqual(Object.keys(p.caps).sort(), caps, p.key);
    assert.ok(p.efforts.length && p.apps.length && p.name, p.key);
    assert.equal(typeof p.modelArgs, "function", p.key);
  }
});

test("a terminal's account: the hook's label, else a single-account provider by its app", () => {
  assert.equal(terminalAccount({ labels: { "agent.account": "team" }, agent: "claude" }), "team");
  assert.equal(terminalAccount({ labels: {}, agent: "codex" }), "codex");
  // Claude has several accounts, so its app alone doesn't say which.
  assert.equal(terminalAccount({ labels: {}, agent: "claude" }), null);
  assert.equal(terminalAccount({ labels: {}, agent: "pi" }), null);
});

test("a handoff resumes only between accounts of a provider that forks", () => {
  const home = "/h", id = "0e6c7a4e-1111-4222-8333-944455556666", transcript = `/h/.claude/projects/-code-app/${id}.jsonl`;
  const accounts = [
    { key: "personal", claudeDir: ".claude" },
    { key: "work", claudeDir: ".claude-work" },
    { key: "codex", provider: "codex" },
  ];
  assert.equal(handoffPlan({ from: "personal", to: "work", transcript, accounts, home }).mode, "resume");
  assert.equal(handoffPlan({ from: "personal", to: "codex", transcript, accounts, home }).mode, "note");
  assert.equal(handoffPlan({ from: "codex", to: "work", transcript, accounts, home }).mode, "note");
});

test("validate: claudeDir is a Claude account's; an unknown provider is caught", () => {
  const at = (edit) => { const c = plain(example); edit(c); return validate(c).map((e) => e.at); };
  assert.deepEqual(at((c) => { c.ACCOUNTS[0].provider = "claude"; }), []);
  assert.ok(at((c) => { delete c.ACCOUNTS[0].claudeDir; }).includes("accounts.0.claudeDir"));
  assert.ok(!at((c) => { c.ACCOUNTS[0].provider = "codex"; delete c.ACCOUNTS[0].claudeDir; }).includes("accounts.0.claudeDir"));
  assert.ok(at((c) => { c.ACCOUNTS[0].provider = "gemini"; }).includes("accounts.0.provider"));
});
