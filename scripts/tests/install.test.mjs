// The installer against throwaway Herdr folders and a small copy of a checkout. Nothing here touches the real home.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { install, uninstall, doctor, plan, readManifest, main } from "../relevo.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let base, source, root, lines;
const log = (line) => lines.push(line);
const put = (dir, rel, body) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
const get = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const has = (rel) => fs.existsSync(path.join(root, rel));
const hows = (steps) => Object.fromEntries(steps.filter((s) => s.how !== "same").map((s) => [s.rel, s.how]));

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relevo-install-")));
  source = path.join(base, "src"); root = path.join(base, "app"); lines = [];
  fs.mkdirSync(root);
  for (const mod of ["relevo", "relevo-agents", "relevo-files", "relevo-tabs"]) {
    put(source, `mods/${mod}/mod.json`, "{}");
    put(source, `mods/${mod}/main.js`, `// ${mod} v1\n`);
  }
  put(source, "mods/relevo/lib/a.js", "a1\n");
  put(source, "mods/relevo/test/a.test.mjs", "never installed\n");
  put(source, "mods/relevo/config.js", 'export const ACCOUNTS = [{ key: "personal" }];\n');
  put(source, "layouts/relevo.json", "{}\n"); put(source, "layouts/relevo.svg", "<svg/>\n");
  put(source, "keys.json", JSON.stringify({ "layout:relevo": { "cmd-j": "relevo.next-waiting", "cmd-alt-p": "relevo.launch-personal", "cmd-alt-o": "relevo.launch-work" } }));
  put(source, "CHANGELOG.md", "# Changelog\n\n## 1.2.3 · today\n");
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

test("a first install writes the files, config.js and the keys of the accounts there, and records them", () => {
  install({ source, root, log });
  assert.equal(get("mods/relevo/lib/a.js"), "a1\n");
  assert.equal(has("mods/relevo/test/a.test.mjs"), false);
  assert.match(get("mods/relevo/config.js"), /personal/);
  assert.deepEqual(JSON.parse(get("keys.json")), { "layout:relevo": { "cmd-j": "relevo.next-waiting", "cmd-alt-p": "relevo.launch-personal" } });
  const manifest = readManifest(root);
  assert.equal(manifest.version, "1.2.3");
  assert.equal("mods/relevo/config.js" in manifest.files, false);
  assert.equal(Object.keys(manifest.files).length, 11);
  assert.match(lines.at(-1), /^Installed Relevo 1\.2\.3 in .*: 12 new, 2 keys\.$/);
});

test("running it again changes nothing, and a dry run writes nothing at all", () => {
  install({ source, root, dry: true, log });
  assert.deepEqual(fs.readdirSync(root), []);
  assert.match(lines.at(-1), /^Would install/);
  install({ source, root });
  const before = fs.statSync(path.join(root, "mods/relevo/main.js")).mtimeMs;
  lines = []; install({ source, root, log });
  assert.deepEqual(lines, [`Installed Relevo 1.2.3 in ${root}: nothing to change.`]);
  assert.equal(fs.statSync(path.join(root, "mods/relevo/main.js")).mtimeMs, before);
  assert.equal(has("relevo-install/backups"), false);
});

test("an update replaces what was left as installed, keeps a changed file with the new one beside it, and removes what is no longer shipped", () => {
  install({ source, root });
  put(root, "mods/relevo/main.js", "// mine\n");
  put(root, "mods/relevo/config.js", "// my accounts\n");
  put(root, "mods/relevo/icons/me.png", "png");
  put(source, "mods/relevo/main.js", "// relevo v2\n");
  put(source, "mods/relevo/lib/a.js", "a2\n");
  put(source, "mods/relevo/config.js", "// a new example\n");
  fs.rmSync(path.join(source, "mods/relevo-tabs/main.js"));
  put(source, "mods/relevo/lib/b.js", "b\n");
  const { steps } = install({ source, root, log });
  assert.deepEqual(hows(steps), { "mods/relevo/main.js": "keep", "mods/relevo/lib/a.js": "update", "mods/relevo/lib/b.js": "new", "mods/relevo-tabs/main.js": "remove" });
  assert.equal(get("mods/relevo/main.js"), "// mine\n");
  assert.equal(get("mods/relevo/main.js.new"), "// relevo v2\n");
  assert.equal(get("mods/relevo/lib/a.js"), "a2\n");
  assert.equal(get("mods/relevo/config.js"), "// my accounts\n");
  assert.equal(get("mods/relevo/icons/me.png"), "png");
  assert.equal(has("mods/relevo-tabs/main.js"), false);
  const backup = path.join(root, "relevo-install/backups", fs.readdirSync(path.join(root, "relevo-install/backups"))[0]);
  assert.equal(fs.readFileSync(path.join(backup, "mods/relevo/lib/a.js"), "utf8"), "a1\n");
  assert.equal(fs.readFileSync(path.join(backup, "mods/relevo-tabs/main.js"), "utf8"), "// relevo-tabs v1\n");
  // Once merged and the .new deleted, the same version is not offered again; the next one is.
  fs.rmSync(path.join(root, "mods/relevo/main.js.new"));
  assert.deepEqual(hows(install({ source, root }).steps), { "mods/relevo/main.js": "stay" });
  assert.equal(has("mods/relevo/main.js.new"), false);
  put(source, "mods/relevo/main.js", "// relevo v3\n");
  install({ source, root });
  assert.equal(get("mods/relevo/main.js.new"), "// relevo v3\n");
});

test("files copied by hand before any record are replaced with a backup; a key or command already bound stays", () => {
  put(root, "mods/relevo/main.js", "// copied by hand, older\n");
  put(root, "keys.json", JSON.stringify({ global: { "cmd-k": "relevo.next-waiting" }, "layout:relevo": { "cmd-alt-p": "something.else" } }));
  const { steps } = install({ source, root, log });
  assert.equal(hows(steps)["mods/relevo/main.js"], "adopt");
  assert.equal(get("mods/relevo/main.js"), "// relevo v1\n");
  const stamp = fs.readdirSync(path.join(root, "relevo-install/backups"))[0];
  assert.equal(fs.readFileSync(path.join(root, "relevo-install/backups", stamp, "mods/relevo/main.js"), "utf8"), "// copied by hand, older\n");
  assert.deepEqual(JSON.parse(get("keys.json")), { global: { "cmd-k": "relevo.next-waiting" }, "layout:relevo": { "cmd-alt-p": "something.else" } });
  assert.ok(lines.some((l) => /cmd-alt-p \(relevo\.launch-personal\) not added/.test(l)));
});

test("a linked keys.json stays linked, and one that is not JSON is left alone", () => {
  put(base, "dotfiles/keys.json", "{}");
  fs.symlinkSync(path.join(base, "dotfiles/keys.json"), path.join(root, "keys.json"));
  install({ source, root });
  assert.equal(fs.lstatSync(path.join(root, "keys.json")).isSymbolicLink(), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(base, "dotfiles/keys.json"), "utf8"))["layout:relevo"]["cmd-j"], "relevo.next-waiting");
  fs.writeFileSync(path.join(base, "dotfiles/keys.json"), "// comments\n{}");
  install({ source, root, log });
  assert.equal(fs.readFileSync(path.join(base, "dotfiles/keys.json"), "utf8"), "// comments\n{}");
  assert.ok(lines.some((l) => /not plain JSON/.test(l)));
});

test("a checkout with nothing to install, or a Herdr folder that isn't there, fails and writes nothing", () => {
  fs.rmSync(path.join(source, "mods/relevo-files"), { recursive: true });
  assert.throws(() => plan(source, root), /not a Relevo checkout: mods\/relevo-files\/mod\.json is missing/);
  assert.equal(main(["install", "--source", source, "--root", root], { log, env: {} }), 1);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(main(["install", "--root", path.join(base, "nowhere")], { log, env: {} }), 1);
  assert.equal(main(["install", "--frob"], { log, env: {} }), 2);
  assert.equal(main(["nonsense"], { log, env: {} }), 2);
});

test("doctor passes a whole install and names what is missing, changed or waiting", () => {
  assert.equal(doctor({ source, root, filesOnly: true, log }).failed, 1);
  assert.match(lines.at(-1), /^FAIL  Relevo is not installed/);
  install({ source, root });
  lines = [];
  assert.equal(doctor({ source, root, filesOnly: true, log }).failed, 0);
  assert.deepEqual(lines, ["ok    11 files of Relevo 1.2.3", "ok    config.js is there"]);
  fs.rmSync(path.join(root, "mods/relevo/lib/a.js"));
  put(root, "mods/relevo/main.js", "// mine\n");
  put(root, "mods/relevo/main.js.new", "// theirs\n");
  put(source, "CHANGELOG.md", "## 1.3.0\n");
  lines = [];
  assert.equal(doctor({ source, root, filesOnly: true, log }).failed, 1);
  assert.deepEqual(lines, ["FAIL  missing: mods/relevo/lib/a.js. Run install.", "warn  changed since install (kept as yours): mods/relevo/main.js",
    "warn  mods/relevo/main.js.new waits: merge it into your file, then delete it", "ok    config.js is there",
    "warn  installed 1.2.3, this checkout is 1.3.0: run install to update"]);
});

test("doctor checks the programs, the two community mods and the keys", () => {
  install({ source, root });
  const bin = path.join(base, "bin"); fs.mkdirSync(bin);
  for (const name of ["git", "hc", "jq", "claude"]) fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.mkdirSync(path.join(root, "mods/issues"));
  fs.writeFileSync(path.join(root, "keys.json"), "{}");
  const result = doctor({ source, root, env: { PATH: bin, HOME: base }, log });
  assert.equal(result.failed, 2);
  assert.ok(lines.includes("FAIL  mod space-folders is missing: install it from herdr.dev"));
  assert.ok(lines.includes("FAIL  gh is not on PATH"));
  assert.ok(lines.includes("ok    mod issues") && lines.includes("ok    claude") && lines.includes("ok    hc"));
  assert.ok(lines.some((l) => /^warn  2 of Relevo's keys are not in keys\.json \(relevo\.next-waiting, relevo\.launch-personal\)/.test(l)));
});

test("uninstall removes what it installed, keeps what the person changed and their config.js", () => {
  install({ source, root });
  put(root, "mods/relevo/main.js", "// mine\n");
  put(root, "mods/relevo/icons/me.png", "png");
  uninstall({ root, dry: true });
  assert.equal(has("mods/relevo-agents/main.js"), true);
  const { removed, kept } = uninstall({ root, log });
  assert.deepEqual({ removed, kept }, { removed: 10, kept: 1 });
  assert.equal(has("mods/relevo-agents"), false);
  assert.equal(get("mods/relevo/main.js"), "// mine\n");
  assert.equal(has("mods/relevo/config.js") && has("mods/relevo/icons/me.png") && has("keys.json"), true);
  assert.equal(has("mods/relevo/lib"), false);
  assert.throws(() => uninstall({ root }), /No install record/);
});

test("this checkout installs whole into a new folder, passes its doctor and uninstalls", () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(REPO, "scripts/relevo.mjs"), ...args, "--root", root], { encoding: "utf8" });
  const dry = run("install", "--dry-run");
  assert.equal(dry.status, 0, dry.stdout);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(run("install").status, 0);
  assert.ok(has("mods/relevo/runtime/roles/reviewer.md") && has("mods/relevo/hooks/relevo-labels.sh") && has("layouts/relevo.json"));
  assert.equal(has("mods/relevo/test"), false);
  const check = run("doctor", "--files-only");
  assert.equal(check.status, 0, check.stdout);
  assert.equal(run("uninstall").status, 0);
  assert.equal(has("mods/relevo-tabs"), false);
});

test("a key still on the command Relevo gave it before moves to the new one; one the person rebound since stays", () => {
  const keys = (map) => put(source, "keys.json", JSON.stringify({ "layout:relevo": map }));
  put(root, "keys.json", JSON.stringify({ "layout:relevo": { "cmd-alt-3": "relevo.panel-inbox", "cmd-alt-4": "relevo.panel-issues" } }));
  keys({ "cmd-alt-3": "relevo.panel-reviews", "cmd-alt-4": "relevo.panel-runs", "cmd-alt-5": "relevo.panel-issues" });
  install({ source, root, log });
  assert.deepEqual(JSON.parse(get("keys.json"))["layout:relevo"], { "cmd-alt-3": "relevo.panel-reviews", "cmd-alt-4": "relevo.panel-runs", "cmd-alt-5": "relevo.panel-issues" });
  assert.ok(lines.includes("key    cmd-alt-4: relevo.panel-issues → relevo.panel-runs"));
  // With a record, only what Relevo itself installed moves.
  put(root, "keys.json", JSON.stringify({ "layout:relevo": { "cmd-alt-3": "relevo.panel-reviews", "cmd-alt-4": "relevo.panel-issues", "cmd-alt-5": "relevo.panel-runs" } }));
  keys({ "cmd-alt-3": "relevo.panel-prs", "cmd-alt-4": "relevo.panel-runs", "cmd-alt-5": "relevo.panel-issues" });
  install({ source, root });
  assert.deepEqual(JSON.parse(get("keys.json"))["layout:relevo"], { "cmd-alt-3": "relevo.panel-prs", "cmd-alt-4": "relevo.panel-issues", "cmd-alt-5": "relevo.panel-runs" });
});
