// The post-update smoke test against a fake Herdr: what passes, what fails, and when the mod runs it.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "./fake/herdr.mjs";
import { smoke, smokeDue, smokeRecord, versions, RELEVO_MODS, SMOKE_FILE } from "../lib/smoke.js";

const { smokeAfterUpdate } = await import("../smoke-watch.js");
const HOME = "/home/test/.config/herdr-app";

// A Herdr where everything works; `over` replaces the answer to "command first-arg".
const herdr = (over = {}) => async (command, args) => {
  const key = `${command} ${args[0]}`;
  if (key in over) return typeof over[key] === "function" ? over[key](args) : over[key];
  const answers = {
    "herdr-app --version": { code: 0, stdout: "herdr-app 0.1.16\n" },
    "hc --version": { code: 0, stdout: "hc 0.1.21\n" },
    "herdr-app check": { code: 0, stdout: "check passed\n" },
    "herdr-app status": { code: 0, stdout: JSON.stringify({ errors: [] }) },
    "hc ls": { code: 0, stdout: JSON.stringify({ terminals: [{ address: "t1", state: "live" }] }) },
    "hc get": { code: 0, stdout: JSON.stringify({ state: "live", status_ms: 1, labels: {} }) },
    "hc read": { code: 0, stdout: "$ " },
  };
  return { stderr: "", ...(answers[key] ?? { code: 127, stdout: "" }) };
};
const levels = (r) => r.results.map((x) => `${x.level} ${x.text}`);

beforeEach(() => resetFake());

test("a working Herdr passes, and every installed mod is loaded once", async () => {
  const checked = [];
  const r = await smoke({ run: herdr({ "herdr-app check": (args) => { checked.push(args[1]); return { code: 0, stdout: "" }; } }), modsDir: "/m", installed: RELEVO_MODS });
  assert.equal(r.failed, 0, levels(r).join("\n"));
  assert.deepEqual({ app: r.app, core: r.core }, { app: "0.1.16", core: "0.1.21" });
  assert.deepEqual(checked, RELEVO_MODS.map((m) => `/m/${m}`));
});

test("nothing installed fails instead of passing empty", async () => {
  const r = await smoke({ run: herdr(), modsDir: "/m", installed: [] });
  assert.equal(r.failed, 1);
  assert.match(levels(r).join("\n"), /fail no Relevo mod is installed/);
});

test("a mod that no longer loads names the missing export", async () => {
  const r = await smoke({ run: herdr({ "herdr-app check": { code: 1, stdout: "", stderr: "Could not find export 'props' in module 'herdr'\n\ncheck failed: /m/relevo\n" } }), modsDir: "/m", installed: ["relevo"] });
  assert.equal(r.failed, 1);
  assert.match(levels(r).join("\n"), /fail mod relevo does not load: Could not find export 'props'/);
});

test("changed hc shapes and window errors fail; a closed window or no live terminal only warn", async () => {
  const fails = async (over) => (await smoke({ run: herdr(over), modsDir: "/m", installed: ["relevo"] })).failed;
  assert.equal(await fails({ "hc ls": { code: 0, stdout: "[]" } }), 1, "ls lost its terminals key");
  assert.equal(await fails({ "hc get": { code: 0, stdout: JSON.stringify({ state: "live" }) } }), 1, "get lost status_ms and labels");
  assert.equal(await fails({ "hc read": { code: 2, stdout: "", stderr: "unknown flag --lines" } }), 1);
  assert.equal(await fails({ "herdr-app status": { code: 0, stdout: JSON.stringify({ errors: [{ message: "relevo: boom" }] }) } }), 1);
  assert.equal(await fails({ "hc --version": async () => { throw Error("not installed"); } }), 1, "a program that can't start is a failure, not a crash");
  const quiet = await smoke({ run: herdr({ "herdr-app status": { code: 1, stdout: "" }, "hc ls": { code: 0, stdout: JSON.stringify({ terminals: [] }) } }), modsDir: "/m", installed: ["relevo"] });
  assert.equal(quiet.failed, 0);
  assert.equal(quiet.results.filter((x) => x.level === "warn").length, 2);
});

test("it is due only for a new, known version pair", async () => {
  const now = await versions(herdr());
  assert.equal(smokeDue(null, now), true);
  assert.equal(smokeDue({ app: "0.1.16", core: "0.1.21", passed: false }, now), false, "a failed run is not repeated for the same Herdr");
  assert.equal(smokeDue({ app: "0.1.15", core: "0.1.21" }, now), true);
  assert.equal(smokeDue(null, { app: null, core: "0.1.21" }), false);
  const record = smokeRecord({ app: "1", core: "2", failed: 1, results: [{ level: "fail", text: "x" }] }, 5);
  assert.deepEqual(record, { app: "1", core: "2", passed: false, at: 5, failures: ["x"] });
});

test("the mod runs it once per Herdr update, records it, and speaks only on failure", async () => {
  for (const mod of ["relevo", "relevo-agents"]) fake.files[`${HOME}/mods/${mod}/mod.json`] = "{}";
  const answer = herdr();
  fake.exec = (command, args) => answer(command, args);
  assert.equal((await smokeAfterUpdate()).failed, 0);
  assert.equal(fake.notices.length, 0);
  assert.equal(fake.execs.filter((line) => line.startsWith("herdr-app check")).length, 2, "only the installed mods");
  assert.equal(JSON.parse(fake.files[`${HOME}/${SMOKE_FILE}`]).passed, true);

  fake.execs = [];
  assert.equal(await smokeAfterUpdate(), null, "same versions: not again");
  assert.equal(fake.execs.filter((line) => line.startsWith("herdr-app check")).length, 0);

  const broken = herdr({ "herdr-app --version": { code: 0, stdout: "herdr-app 0.1.17\n" }, "herdr-app check": { code: 1, stdout: "", stderr: "SyntaxError: bad\n" } });
  fake.exec = (command, args) => broken(command, args);
  assert.equal((await smokeAfterUpdate()).failed, 2);
  assert.equal(fake.notices.length, 1);
  assert.match(fake.notices[0].title, /0\.1\.17/);
  assert.equal(fake.notices[0].level, "error");
});

test("never while herdr-app check loads the mod", async () => {
  fake.checking = true;
  assert.equal(await smokeAfterUpdate(), null);
  assert.equal(fake.execs.length, 0);
});
