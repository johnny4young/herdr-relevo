import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, stat, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as example from "../config.example.js";
import { WRITE_SCRIPT, renderConfig, validate, slug, parseList } from "../lib/settings.js";

const plain = (m) => JSON.parse(JSON.stringify({ ...m }));

async function roundTrip(config) {
  const dir = await mkdtemp(join(tmpdir(), "relevo-settings-"));
  try {
    const file = join(dir, "config.mjs");
    await writeFile(file, renderConfig(config));
    return plain(await import(pathToFileURL(file).href));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("renderConfig: the example's values import back unchanged", async () => {
  assert.deepEqual(await roundTrip(plain(example)), plain(example));
});

test("renderConfig: odd strings survive and long entries wrap under 130 columns", async () => {
  const c = plain(example);
  c.ACCOUNTS[0].launcher = `say "hi" \\ 'there' $HOME \`x\` ${"z".repeat(140)}`;
  c.ACCOUNTS[1].label = "Trabajo — ñandú";
  c.CONTEXTS[1].orgs = Array.from({ length: 30 }, (_, i) => `org-${i}`);
  c.FALLBACK = Array.from({ length: 2 }, () => "personal");
  assert.deepEqual(await roundTrip(c), c);
  const lines = renderConfig(plain(example)).split("\n");
  assert.ok(lines.every((l) => l.length <= 130));
  assert.equal(lines.filter((l) => l.startsWith("export const ")).length, 8);
});

test("renderConfig: what Settings doesn't edit is written back, with its note", async () => {
  const c = { ...plain(example), RUN_MUST_FIX: "minor", RUN_CODEX_MODEL: "gpt-x", MY_LIST: ["a", "b"], MY_MAP: { a: 1 }, MY_FLAG: false };
  assert.deepEqual(await roundTrip({ ...c, helper: () => 1, MISSING: undefined }), c);
  const text = renderConfig(c);
  assert.match(text, /\/\/ A run's reviewer sends the work back only for findings at this level or above[^\n]*\nexport const RUN_MUST_FIX = "minor";/);
  assert.match(text, /\/\/ The model a run's Codex agent uses\.\nexport const RUN_CODEX_MODEL = "gpt-x";/);
});

test("validate: the example is valid", () => {
  assert.deepEqual(validate(plain(example)), []);
});

const broken = (edit) => {
  const c = plain(example);
  edit(c);
  return validate(c).map((e) => e.at);
};

test("validate: catches each rule", () => {
  assert.ok(broken((c) => { c.ACCOUNTS = []; }).includes("accounts"));
  for (const field of ["key", "label", "letter", "launcher", "claudeDir", "bg", "fg"]) {
    assert.ok(broken((c) => { c.ACCOUNTS[1][field] = ""; }).includes(`accounts.1.${field}`), field);
  }
  assert.ok(broken((c) => { c.ACCOUNTS[1].key = "personal"; }).includes("accounts.1.key"));
  assert.ok(broken((c) => { c.ACCOUNTS[1].key = "codex"; }).includes("accounts.1.key"));
  assert.ok(broken((c) => { c.ACCOUNTS[1].key = "a/b"; }).includes("accounts.1.key"));
  assert.ok(broken((c) => { c.ACCOUNTS[0].bg = "green"; }).includes("accounts.0.bg"));
  assert.ok(broken((c) => { c.ACCOUNTS[0].fg = "#12345"; }).includes("accounts.0.fg"));
  assert.ok(broken((c) => { c.ACCOUNTS[0].letter = "ABC"; }).includes("accounts.0.letter"));
  assert.ok(broken((c) => { c.REPLIES = ["Continue", "Continue"]; }).includes("replies"));
  assert.ok(broken((c) => { c.CODEX.launcher = " "; }).includes("codex.launcher"));
  assert.ok(broken((c) => { c.CONTEXTS = []; }).includes("contexts"));
  assert.ok(broken((c) => { c.CONTEXTS[1].label = ""; }).includes("contexts.1.label"));
  assert.ok(broken((c) => { c.CONTEXTS[1].key = "personal"; }).includes("contexts.1.label"));
  assert.ok(broken((c) => { c.CONTEXTS[0].orgs = ["acme"]; }).includes("contexts.0.orgs"));
  assert.ok(broken((c) => { c.CONTEXTS[1].account = "nobody"; }).includes("contexts.1.account"));
  assert.ok(broken((c) => { c.FALLBACK = ["personal", "nobody"]; }).includes("fallback"));
  assert.ok(broken((c) => { c.FALLBACK = ["personal", "personal"]; }).includes("fallback"));
  assert.ok(broken((c) => { c.REPOS_ROOT = ""; }).includes("reposRoot"));
  assert.ok(broken((c) => { c.REPOS_ROOT = "/home/me/code"; }).includes("reposRoot"));
  assert.ok(broken((c) => { c.REPOS_ROOT = "~/code"; }).includes("reposRoot"));
  assert.ok(broken((c) => { c.BACKUPS_ROOT = "/tmp/x"; }).includes("backupsRoot"));
  assert.ok(!broken((c) => { delete c.BACKUPS_ROOT; }).includes("backupsRoot"));
  assert.ok(broken((c) => { c.SKILLS.fix = ""; }).includes("skills.fix"));
  assert.ok(broken((c) => { delete c.SKILLS.comments; }).includes("skills"));
});

test("slug and parseList", () => {
  assert.equal(slug("  Client Work — Ñu! "), "client-work-nu");
  assert.deepEqual(parseList(" a, b,, c ,"), ["a", "b", "c"]);
});

test("WRITE_SCRIPT: replaces the file in one rename, text passed as argv", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relevo-write-"));
  try {
    const file = join(dir, "config.js"), text = "x $(touch pwned) `y` \"z\" %s\n";
    await writeFile(file, "old");
    execFileSync("sh", ["-c", WRITE_SCRIPT, "sh", file, text]);
    assert.equal(await readFile(file, "utf8"), text);
    assert.deepEqual(await readdir(dir), ["config.js"]);
    assert.equal((await stat(file)).mode & 0o777, 0o644);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
