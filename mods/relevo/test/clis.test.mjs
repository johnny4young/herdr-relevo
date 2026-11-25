// Which agent CLIs the machine has, what Reviews offers for each and what config.js gets.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fake, resetFake } from "./fake/herdr.mjs";
import { fakeCx, find, text, click, flush } from "./fake/ui.mjs";
import * as example from "../config.example.js";
import { FIND_SCRIPT, cliOffers, newAccount, parseIntegrations, withCli } from "../lib/clis.js";
import { renderConfig, validate } from "../lib/settings.js";
import { PROVIDERS } from "../lib/providers.js";

const plain = (m) => JSON.parse(JSON.stringify({ ...m }));
const STATUS = `pi: current (v9) (/h/.pi/agent/extensions/herdr-agent-state.ts)
claude: current (v11) (/h/.claude/hooks/herdr-agent-state.sh)
codex: outdated (v9 < v10) (/h/.codex/herdr-agent-state.sh)
antigravity-cli: not installed (/h/.gemini/config/hooks/herdr-agent-state.sh)
letta (experimental): not installed (/h/.letta/hooks/herdr-agent-session.sh)`;

beforeEach(() => resetFake());

test("herdr integration status reads as each hook's state and version", () => {
  const i = parseIntegrations(STATUS);
  assert.deepEqual(i.codex, { state: "outdated", have: 9, want: 10 });
  assert.deepEqual(i.claude, { state: "current", have: 11, want: 11 });
  assert.deepEqual(i["antigravity-cli"], { state: "not installed", have: null, want: null });
  assert.equal(i.letta.state, "not installed");
  assert.deepEqual(parseIntegrations(""), {});
});

test("Reviews offers a one-login CLI found but not configured, and a hook to update for one in use", () => {
  const integrations = parseIntegrations(STATUS), found = { claude: true, codex: true, agy: true };
  const base = { found, integrations, configured: ["claude", "codex"], on: ["claude", "codex"], ignored: [] };
  assert.deepEqual(cliOffers(base), [{ provider: "codex", kind: "hook", hook: "outdated" }, { provider: "agy", kind: "new", hook: "not installed" }]);
  // Turned down, off, or not on the machine: nothing to offer.
  assert.deepEqual(cliOffers({ ...base, ignored: ["agy"], on: ["claude"] }), []);
  assert.deepEqual(cliOffers({ ...base, found: { claude: true } }), []);
  // Without Herdr's answer, a CLI is still offered, with no word on its hook.
  assert.deepEqual(cliOffers({ ...base, integrations: null }), [{ provider: "agy", kind: "new", hook: null }]);
});

test("activating a CLI adds its account to config.js; ignoring remembers it", () => {
  assert.deepEqual(newAccount("agy"), { key: "agy", provider: "agy", ...PROVIDERS.agy.chip, launcher: "agy" });
  assert.equal(newAccount("claude"), null);
  const c = plain(example);
  const on = withCli(c, "agy", "activate");
  assert.deepEqual(on.OTHER_CLIS, [newAccount("agy")]);
  assert.deepEqual(validate(on), []);
  assert.deepEqual(withCli({ ...c, IGNORED_CLIS: ["agy"] }, "agy", "activate").IGNORED_CLIS, []);
  assert.deepEqual(withCli(c, "agy", "ignore").IGNORED_CLIS, ["agy"]);
  assert.deepEqual(withCli(withCli(c, "agy", "ignore"), "agy", "ignore").IGNORED_CLIS, ["agy"]);
});

test("validate: another CLI is a one-login provider other than Codex, keyed as it", () => {
  const at = (cli) => validate({ ...plain(example), OTHER_CLIS: [cli] }).map((e) => e.at);
  const agy = newAccount("agy");
  assert.deepEqual(at(agy), []);
  assert.ok(at({ ...agy, provider: "claude" }).includes("otherClis.0.provider"));
  assert.ok(at({ ...agy, provider: "codex", key: "codex" }).includes("otherClis.0.provider"));
  assert.ok(at({ ...agy, key: "gemini" }).includes("otherClis.0.key"));
  assert.ok(at({ ...agy, launcher: " " }).includes("otherClis.0.launcher"));
});

test("renderConfig writes the other CLIs and the ignored ones back", async () => {
  const c = { ...plain(example), OTHER_CLIS: [{ ...newAccount("agy"), on: false }], IGNORED_CLIS: ["agy"] };
  const dir = await mkdtemp(join(tmpdir(), "relevo-clis-"));
  try {
    await writeFile(join(dir, "config.mjs"), renderConfig(c));
    assert.deepEqual(plain(await import(pathToFileURL(join(dir, "config.mjs")).href)), c);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FIND_SCRIPT names only the CLIs on PATH", async () => {
  const { execFileSync } = await import("node:child_process");
  assert.equal(execFileSync("sh", ["-c", FIND_SCRIPT, "sh", "sh", "no-such-cli-here"]).toString(), "sh\n");
});

test("an agent CLI starts on its own first-prompt flags", async () => {
  const { launchArgv } = await import("../accounts.js");
  assert.deepEqual(launchArgv("personal", "hi", ["-x"]).slice(-5), ["-ilc", 'claude "$2" "$1"', "zsh", "hi", "-x"]);
  assert.deepEqual(PROVIDERS.agy.promptArgs("hi"), ["-i", "hi"]);
});

test("Now lists a CLI found on the machine, and Activate writes it into config.js", async () => {
  const writes = [];
  fake.exec = (cmd, args) => {
    const line = (args ?? []).join(" ");
    if (line.includes("command -v")) return { code: 0, stdout: "claude\ncodex\nagy\n" };
    if (line.includes("herdr integration status")) return { code: 0, stdout: STATUS };
    if (cmd === "sh" && args[1]?.includes("mktemp")) { writes.push(args.at(-1)); return { code: 0, stdout: "" }; }
    return null;
  };
  const { Inbox } = await import("../inbox.js");
  const inbox = new Inbox(), cx = fakeCx();
  inbox.init({}, cx);
  for (let i = 0; i < 5; i++) await flush();
  const ui = () => inbox.render(cx);
  assert.match(text(find(ui(), "leg-clis")), /AGENT CLIS/);
  assert.match(text(find(ui(), "cli-agy")), /Antigravity CLI/);
  assert.match(text(find(ui(), "cli-agy")), /agy found · no Herdr hook/);
  assert.match(text(find(ui(), "cli-codex")), /Herdr hook outdated/);
  click(find(ui(), "cli-agy-on"), cx);
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(writes.length, 1);
  assert.match(writes[0], /export const OTHER_CLIS = \[\n {2}\{ key: "agy", provider: "agy",/);
});

test("Antigravity is full while one of its agents reports its quota reached, and unknown otherwise", async () => {
  const { reportedQuota, full } = await import("../accounts.js");
  const msg = "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h0m0s.";
  const q = reportedQuota(PROVIDERS.agy, [{ agent: "claude", report: { msg } }, { agent: "antigravity", report: { kind: "error", msg } }]);
  assert.equal(q.h5.pct, 100);
  assert.equal(full(q), "5h");
  assert.equal(reportedQuota(PROVIDERS.agy, [{ agent: "agy", report: { msg: "Approve Bash: rm a.txt" } }, { agent: "claude", report: { msg } }]), null);
});
