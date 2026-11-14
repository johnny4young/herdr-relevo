// The optional hook in hooks/relevo-labels.sh, run with bash in a temp home; a fake hc writes down its labels.
import { test, beforeEach, afterEach } from "node:test";
import { URL } from "node:url";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SOURCE = new URL("../hooks/relevo-labels.sh", import.meta.url).pathname;
const CONFIG = `export const ACCOUNTS = [
  { key: "personal", label: "Personal", letter: "P", launcher: "claude", claudeDir: ".claude", bg: "#000", fg: "#fff" },
  {
    key: "work", label: "Work", letter: "W", launcher: "x", claudeDir: ".claude-work",
    bg: "#000", fg: "#fff",
  },
];
export const CODEX = { key: "codex", label: "Codex", letter: "X", launcher: "codex", bg: "#000", fg: "#fff" };
`;
const EVENTS = ["SessionStart", "Stop", "SessionEnd", "PermissionRequest"];

let home, script, settingsPath, log;
beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relevo-hook-")));
  fs.mkdirSync(path.join(home, "mod/hooks"), { recursive: true });
  fs.mkdirSync(path.join(home, "bin"));
  fs.mkdirSync(path.join(home, ".claude"));
  script = path.join(home, "mod/hooks/relevo-labels.sh");
  fs.copyFileSync(SOURCE, script);
  fs.writeFileSync(path.join(home, "mod/config.js"), CONFIG);
  log = path.join(home, "hc.log");
  fs.writeFileSync(path.join(home, "bin/hc"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> '${log}'\n`, { mode: 0o755 });
  settingsPath = path.join(home, ".claude/settings.json");
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const env = (extra = {}) => ({ PATH: `${home}/bin:/usr/bin:/bin`, HOME: home, ...extra });
const run = (args, extra) => spawnSync("bash", [script, ...args], { env: env(extra), encoding: "utf8" });
const hook = (data, extra = {}) => {
  const r = spawnSync("bash", [script], { env: env({ HC_TERMINAL_ID: "t1", ...extra }), input: JSON.stringify(data), encoding: "utf8" });
  assert.equal(r.status, 0);
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
};
const labels = (lines) => Object.fromEntries(lines.slice(2).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const repo = (branch) => {
  const dir = path.join(home, "repo");
  fs.mkdirSync(dir);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "checkout", "-q", "-b", branch]);
  return dir;
};
const read = () => JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const write = (value) => fs.writeFileSync(settingsPath, typeof value === "string" ? value : JSON.stringify(value));
const backups = () => fs.readdirSync(path.join(home, ".claude")).filter((f) => f.startsWith("settings.json.relevo-backup-"));
const installedCommand = () => `[ -f ${script} ] && bash ${script} || true`;

test("a stop sets every label, background work counted most first", () => {
  const cwd = repo("feat/ABC-12-x");
  const got = hook({
    hook_event_name: "Stop", cwd, transcript_path: "/t.jsonl",
    background_tasks: [{ type: "agent" }, { type: "shell" }, { type: "shell" }, {}], session_crons: [{}],
  }, { CLAUDE_CONFIG_DIR: `${home}/.claude-work/` });
  assert.deepEqual(got.slice(0, 2), ["label", "t1"]);
  assert.deepEqual(labels(got), {
    "agent.wait": "watch", "agent.bg": "⧗ 2 shells · 1 agent · 1 task", "agent.account": "work",
    "agent.jira": "ABC-12", "agent.transcript": "/t.jsonl",
  });
});

test("wakeups alone, the default account and a branch without a ticket", () => {
  const cwd = repo("feat/trim-ABC-12x");
  assert.deepEqual(labels(hook({ hook_event_name: "Stop", cwd, session_crons: [{}, {}] })), {
    "agent.wait": "timer", "agent.bg": "⏰ 2 wakeups", "agent.account": "personal", "agent.jira": "", "agent.transcript": "",
  });
});

test("an account folder that isn't in config.js leaves the account empty", () => {
  assert.equal(labels(hook({ hook_event_name: "SessionStart" }, { CLAUDE_CONFIG_DIR: `${home}/.other` }))["agent.account"], "");
});

test("session end clears every label", () => {
  const got = labels(hook({ hook_event_name: "SessionEnd", transcript_path: "/t.jsonl", background_tasks: [{}] }));
  assert.deepEqual(Object.keys(got), ["agent.wait", "agent.bg", "agent.account", "agent.jira", "agent.transcript"]);
  assert.deepEqual(new Set(Object.values(got)), new Set([""]));
});

test("outside a Herdr terminal, or with input it can't read, it does nothing and exits 0", () => {
  assert.deepEqual(hook({ hook_event_name: "Stop" }, { HC_TERMINAL_ID: "" }), []);
  const r = spawnSync("bash", [script], { env: env({ HC_TERMINAL_ID: "t1" }), input: "{not json", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(log), false);
});

test("install keeps everything else, and running it again changes nothing", () => {
  const other = { hooks: [{ type: "command", command: "other" }] };
  write({ model: "m", hooks: { Stop: [other] } });
  assert.equal(run(["--check"]).status, 1);
  assert.equal(run(["--install"]).status, 0);
  const first = fs.readFileSync(settingsPath, "utf8"), settings = JSON.parse(first);
  assert.equal(settings.model, "m");
  assert.deepEqual(settings.hooks.Stop[0], other);
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...EVENTS].sort());
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, installedCommand());
  assert.equal(backups().length, 1);
  assert.equal(run(["--check"]).status, 0);
  run(["--install"]);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), first);
  assert.equal(backups().length, 1);
});

test("the command exits 0 when the script is gone", () => {
  run(["--install"]);
  const gone = read().hooks.Stop[0].hooks[0].command.replaceAll(script, path.join(home, "moved/relevo-labels.sh"));
  assert.equal(spawnSync("sh", ["-c", gone]).status, 0);
});

test("commands for a moved script are outdated and get replaced", () => {
  const moved = `${home}/old place/relevo-labels.sh`;
  const old = (command) => ({ hooks: [{ type: "command", command }] });
  const other = { hooks: [{ type: "command", command: "other" }] };
  write({ hooks: {
    SessionStart: [old("[ -f /old/relevo-labels.sh ] && bash /old/relevo-labels.sh || true")],
    Stop: [other, old(`[ -f '${moved}' ] && bash '${moved}' || true`)],
    SessionEnd: [old(`[ -f '${moved}' ] && bash '${moved}' || true`)],
  } });
  const check = run(["--check"]);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /personal \(\.claude\): outdated/);
  run(["--install"]);
  assert.equal(run(["--check"]).status, 0);
  const stop = read().hooks.Stop;
  assert.deepEqual(stop[0], other);
  assert.equal(stop.length, 2);
  for (const e of EVENTS) assert.deepEqual(read().hooks[e].flatMap((g) => g.hooks.map((h) => h.command)).filter((c) => c !== "other"), [installedCommand()]);
});

test("a stale command beside the current one is cleaned", () => {
  run(["--install"]);
  const settings = read();
  settings.hooks.Stop.push({ hooks: [{ type: "command", command: "[ -f /moved/away/relevo-labels.sh ] && bash /moved/away/relevo-labels.sh || true" }] });
  write(settings);
  const check = run(["--check"]);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /outdated/);
  run(["--install"]);
  assert.equal(run(["--check"]).status, 0);
  assert.equal(read().hooks.Stop.length, 1);
});

test("someone else's command and the entry's own settings stay", () => {
  const own = { type: "command", command: "tee log | bash /old/relevo-labels.sh; backup.sh" };
  const old = { type: "command", command: "[ -f /old/relevo-labels.sh ] && bash /old/relevo-labels.sh || true", timeout: 5 };
  write({ hooks: { Stop: [{ hooks: [own, old] }] } });
  run(["--install"]);
  const stop = read().hooks.Stop;
  assert.deepEqual(stop[0].hooks[0], own);
  assert.equal(stop[0].hooks[1].timeout, 5);
  assert.equal(stop[0].hooks[1].command, installedCommand());
});

test("uninstall removes only this hook", () => {
  const other = { hooks: [{ type: "command", command: "other" }] };
  write({ model: "m", hooks: { Stop: [other] } });
  run(["--install"]);
  assert.match(run(["--uninstall"]).stdout, /personal \(\.claude\): removed/);
  assert.deepEqual(read(), { model: "m", hooks: { Stop: [other] } });
});

test("invalid settings are left alone", () => {
  write("{not json");
  const r = run(["--install"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not valid JSON/);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), "{not json");
});

test("a symlinked settings file stays linked", () => {
  const real = path.join(home, "real.json");
  fs.writeFileSync(real, "{}");
  fs.symlinkSync(real, settingsPath);
  run(["--install"]);
  assert.ok(fs.lstatSync(settingsPath).isSymbolicLink());
  assert.ok(JSON.parse(fs.readFileSync(real, "utf8")).hooks);
});

test("an account folder that doesn't exist is skipped and never created", () => {
  const r = run(["--install"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /work \(\.claude-work\): no such folder, skipped/);
  assert.equal(fs.existsSync(path.join(home, ".claude-work")), false);
});

test("an unknown option exits 2", () => {
  assert.equal(run(["--nope"]).status, 2);
});

const noteFile = () => path.join(home, ".local/state/relevo/asks/t1.jsonl");
const notes = () => fs.readFileSync(noteFile(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const request = (extra = {}) => ({
  hook_event_name: "PermissionRequest", cwd: "/repo", tool_name: "Bash",
  tool_input: { command: 'printf "a\\nb\\n" > out.txt && cat out.txt', description: "Write two lines" }, ...extra,
});

test("a permission request is noted for the Inbox, answers nothing and sets no label", () => {
  const r = spawnSync("bash", [script], { env: env({ HC_TERMINAL_ID: "t1" }), input: JSON.stringify(request()), encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(fs.existsSync(log), false);
  const [note, ...more] = notes();
  assert.deepEqual(more, []);
  assert.equal(note.terminal, "t1");
  assert.equal(note.tool, "Bash");
  assert.deepEqual(note.input, request().tool_input);
  assert.ok(Math.abs(note.at - Date.now() / 1000) < 60);
  assert.equal(fs.statSync(noteFile()).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(noteFile())).mode & 0o777, 0o700);
});

test("the request before stays beside the new one, and only that one", () => {
  for (const command of ["one", "two", "three"]) hook(request({ tool_input: { command } }));
  assert.deepEqual(notes().map((n) => n.input.command), ["two", "three"]);
});

test("a huge request keeps its start, and a terminal id that is a path writes nothing", () => {
  hook(request({ tool_input: { command: "x".repeat(50000) } }));
  assert.equal(notes()[0].input.command.length, 20001);
  fs.rmSync(noteFile());
  hook(request(), { HC_TERMINAL_ID: "../t1" });
  hook(request(), { HC_TERMINAL_ID: "mac/t1" });
  assert.deepEqual(fs.readdirSync(path.dirname(noteFile())), []);
});

test("the notes go when a session starts, or the turn or the session ends", () => {
  for (const event of ["SessionStart", "Stop", "SessionEnd"]) {
    hook(request());
    assert.equal(fs.existsSync(noteFile()), true);
    hook({ hook_event_name: event });
    assert.equal(fs.existsSync(noteFile()), false, event);
  }
});

test("another event whose text names a permission request is not one", () => {
  hook({ hook_event_name: "Stop", cwd: '"hook_event_name": "PermissionRequest"' });
  assert.equal(fs.existsSync(noteFile()), false);
});

test("a request that can't be noted leaves no older note behind", () => {
  hook(request());
  fs.writeFileSync(path.join(home, "bin/mktemp"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  hook(request({ tool_input: { command: "another" } }));
  assert.equal(fs.existsSync(noteFile()), false);
  fs.rmSync(path.join(home, "bin/mktemp"));
  hook(request());
  spawnSync("bash", [script], { env: env({ HC_TERMINAL_ID: "t1" }), input: '{"hook_event_name": "PermissionRequest", broken', encoding: "utf8" });
  assert.equal(fs.existsSync(noteFile()), false);
});
