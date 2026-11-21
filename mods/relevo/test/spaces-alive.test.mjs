// What runs under its repo in Spaces: terminals with their ports, and servers from other apps. Agents and their sessions stay in Agents.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "./fake/herdr.mjs";
import { fakeCx, find, flush, text } from "./fake/ui.mjs";
import { appOf, outsideServers, parseCwds, parseProcs } from "../lib/terminals.js";

const { aliveBySpace, portsIn } = await import("../../relevo-spaces/model.js");
const { default: Spaces } = await import("../../relevo-spaces/main.js");
const { AliveWatch, ALIVE } = await import("../alive.js");
const { terminalAction } = await import("../terminals.js");

beforeEach(() => resetFake());

const PS = [
  "    1     0 /sbin/launchd",
  "  500     1 /Applications/Ghostty.app/Contents/MacOS/ghostty",
  "  510   500 -zsh",
  "  520   510 node",
  "  600     1 /usr/libexec/rapportd",
  "  700     1 herdr-core",
  "  710   700 -zsh",
  "  720   710 node",
  "  800   500 claude",
].join("\n");

test("a space sitting in the home folder does not take everything under home", () => {
  const { by, loose } = aliveBySpace([row("home", null, {}), { ...row("x", null), path: "/home/test" }], { home: "/home/test",
    alive: { outside: [{ pid: 1, cwd: "/home/test/code/billing", ports: [5173] }] } });
  assert.equal(by.get("x").servers.length, 0);
  assert.equal(loose.length, 1);
});

test("a server started in another app is found, with that app, and Herdr's own, the system's, Claude's and system-assigned ports are left out", () => {
  const procs = parseProcs(PS);
  assert.equal(appOf(520, procs), "Ghostty");
  const listening = [{ pid: 520, port: 5173 }, { pid: 520, port: 24678 }, { pid: 520, port: 53158 }, { pid: 600, port: 7000 }, { pid: 720, port: 3000 }, { pid: 800, port: 8123 }];
  const cwds = parseCwds("p520\nfcwd\nn/home/test/code/billing\np600\nfcwd\nn/\np720\nfcwd\nn/home/test/code/api\np800\nfcwd\nn/home/test/code/api\n");
  assert.deepEqual(outsideServers(listening, procs, new Set([710]), cwds, "/home/test"),
    [{ pid: 520, ports: [5173, 24678], cwd: "/home/test/code/billing", title: "node", app: "Ghostty" }]);
});

const row = (id, top, over = {}) => ({ w: { id, name: id, ...over }, g: top ? { top } : null, path: top });

test("each thing alive goes under the space whose repo holds it, a worktree's under the worktree", () => {
  const rows = [row("api", "/home/test/code/api"), row("wt", "/home/test/code/api/.wt/fix")];
  const { by, loose } = aliveBySpace(rows, {
    agents: [{ address: "t1", space: "api", status: "blocked" }],
    desktop: [{ id: "d1", cwd: "/home/test/code/api/src", state: "working", project: "api" }],
    elsewhere: [{ id: "e1", cwd: "/home/test/code/api/.wt/fix", state: "blocked", project: "api" }],
    alive: {
      terminals: [{ address: "t9", spaceId: "api", live: true, ports: [3000] }, { address: "t8", spaceId: "gone", live: false, cwd: "/tmp" }],
      outside: [{ pid: 520, cwd: "/home/test/code/billing", ports: [5173] }, { pid: 530, cwd: "/home/test/code/api", ports: [4000] }],
    },
  });
  assert.deepEqual(by.get("api").agents.map((a) => a.address), ["t1"]);
  assert.deepEqual(by.get("api").sessions.map((s) => [s.id, s.from]), [["d1", "desktop"]]);
  assert.deepEqual(by.get("wt").sessions.map((s) => s.id), ["e1"]);
  assert.deepEqual(portsIn(by.get("api")), [3000, 4000]);
  assert.deepEqual(loose.map((l) => [l.project, l.servers.length, l.terminals.length]), [["billing", 1, 0]], "a finished terminal is not something alive");
});

async function open(spaces, { alive = null, desktop = [], agents = [], folders = null } = {}) {
  fake.spaces = spaces;
  fake.agents = agents;
  fake.stored["space-folders"] = { "": folders ?? { list: [{ id: "personal", name: "Personal", color: "ansi2", match: "~" }], of: {} } };
  fake.stored["relevo.alive"] = alive;
  fake.stored["relevo.desktop"] = desktop;
  fake.exec = (cmd, args, options) => {
    const a = args.join(" "), cwd = options?.cwd ?? "";
    if (a.includes("--show-toplevel")) return { stdout: `${cwd}\n` };
    if (a.includes("--git-common-dir")) return { stdout: `${cwd}/.git\n` };
    if (a.includes("symbolic-ref")) return { stdout: "refs/heads/main\n" };
    if (a.includes("rev-list")) return { stdout: "0\t0\n" };
    return null;
  };
  localStorage.removeItem("opened");
  localStorage.removeItem("closed");
  const mod = new Spaces(), cx = fakeCx();
  mod.init({}, cx);
  cx.fire(500);
  await flush();
  return { mod, cx, ui: () => mod.render(cx) };
}

test("a space lists what runs, listens or failed; a resting shell stays out", () => {
  const rows = [row("api", "/home/test/code/api")];
  const { by, loose } = aliveBySpace(rows, { alive: { terminals: [
    { address: "t1", spaceId: "api", live: true, state: "idle", ports: [] },
    { address: "t2", spaceId: "api", live: true, state: "old", ports: [] },
    { address: "t3", spaceId: "api", live: true, state: "running", ports: [] },
    { address: "t4", spaceId: "api", live: true, state: "idle", ports: [4100] },
    { address: "t5", spaceId: "api", live: false, state: "failed" },
    { address: "t6", spaceId: "api", live: false, state: "done" },
    { address: "t7", spaceId: "gone", live: true, state: "idle", ports: [], cwd: "/home/test/code/blog" },
  ], outside: [] } });
  assert.deepEqual(by.get("api").terminals.map((x) => x.address), ["t3", "t4", "t5"]);
  assert.deepEqual(loose, []);
});

const space = (id, name, cwd, over = {}) => ({ id, name, folder: cwd, machine: null, active: false, status: null, tabs: [{ id: `tb-${id}` }], ...over });
const ALIVE_NOW = {
  terminals: [{ address: "t9", title: "npm run dev", state: "running", live: true, spaceId: "api", ports: [3000], canRestart: false, canStop: true }],
  outside: [{ pid: 520, title: "vite", cwd: "/home/test/code/billing", ports: [5173], app: "Ghostty" }],
};

test("every space shows what runs in it, and stays closed once you close it", async () => {
  const { cx, ui } = await open([space("api", "api", "/home/test/code/api", { active: true }), space("web", "web", "/home/test/code/web")], {
    alive: { terminals: [...ALIVE_NOW.terminals, { address: "t7", title: "zsh", state: "idle", live: true, spaceId: "web", ports: [4100] }], outside: [] },
    agents: [{ address: "t1", space: "api", status: "blocked", title: "Claude", pane: "p1" }],
  });
  fake.stored["relevo.reasons"] = { t1: "Run: npm test" };
  const shown = ui();
  assert.doesNotMatch(text(shown), /Run: npm test/, "agents are listed in Agents, not here");
  assert.match(text(find(shown, "tm-api-t9")), /npm run dev :3000/);
  assert.ok(find(shown, "tm-web-t7"), "a space you are not in is open too");
  find(shown, "open-web").handlers.on_click({}, cx);
  assert.equal(find(ui(), "tm-web-t7"), null);
  assert.match(text(find(ui(), "space-web")), /:4100/, "closed, its port shows on its row");
  find(ui(), "open-api").handlers.on_click({}, cx);
  assert.equal(find(ui(), "tm-api-t9"), null, "the space you are in closes when you say so");
  assert.deepEqual(JSON.parse(localStorage.getItem("closed")).sort(), ["api", "web"]);
});

test("a port opens in the browser; a terminal's actions go to the Relevo mod, closing only on a second click", async () => {
  const { cx, ui } = await open([space("api", "api", "/home/test/code/api", { active: true })], { alive: ALIVE_NOW });
  find(ui(), "tm-api-t9-port-3000").handlers.on_click({}, cx);
  assert.ok(fake.execs.includes("open http://localhost:3000"));
  find(ui(), "tm-api-t9").handlers.on_hover(true, cx);
  find(ui(), "tm-api-t9-stop").handlers.on_click({}, cx);
  assert.deepEqual(fake.runs.at(-1), ["relevo.term-stop-t9", undefined]);
  find(ui(), "tm-api-t9-close").handlers.on_click({}, cx);
  assert.notDeepEqual(fake.runs.at(-1), ["relevo.term-close-t9", undefined]);
  find(ui(), "tm-api-t9-close").handlers.on_click({}, cx);
  assert.deepEqual(fake.runs.at(-1), ["relevo.term-close-t9", undefined]);
});

test("a repo with a server but no space shows as a row with no space, in the folder that takes its path", async () => {
  const { cx, ui } = await open([space("api", "api", "/home/test/code/api", { active: true })], { alive: ALIVE_NOW });
  const ghost = find(ui(), "ghost-billing");
  assert.match(text(ghost), /billing :5173 no space/);
  assert.match(text(find(ui(), "sv-ghost-billing-520")), /vite in Ghostty :5173/);
  ghost.handlers.on_click({}, cx);
  assert.equal(find(ui(), "sv-ghost-billing-520"), null);
  find(ui(), "ghost-billing-new").handlers.on_click({ }, cx);
  await flush();
  assert.deepEqual(fake.runs.at(-1), ["space.new", { folder: "/home/test/code/billing", machine: "" }]);
});

test("Claude Desktop sessions stay in Agents: none under a space, and none makes a row with no space", async () => {
  const { ui } = await open([space("api", "api", "/home/test/code/api", { active: true })], {
    desktop: [{ id: "local_1", title: "Rate limits", project: "api", cwd: "/home/test/code/api", state: "blocked", needs: "Approve the plan" },
      { id: "local_2", title: "Blog", project: "blog", cwd: "/home/test/code/blog", state: "working" }],
  });
  const drawn = text(ui());
  assert.doesNotMatch(drawn, /Rate limits|Approve the plan|Blog/);
  assert.equal(find(ui(), "ghost-blog"), null);
});

test("the watch publishes terminals with their ports and outside servers, only while the window is in front and when they change", async () => {
  fake.terminals = [{ address: "t9", state: "live", argv: ["/bin/zsh", "-l"], pid: 710, foreground: { pid: 720, name: "node", argv: ["node", "server.mjs"], cwd: "/home/test/code/api" }, cwd: "/home/test/code/api", labels: { "herdr.space": "api" }, created_ms: Date.now() }];
  fake.exec = (cmd, args) => {
    if (cmd === "lsof" && args.includes("-iTCP")) return { stdout: "p720\nn*:3000\np520\nn*:5173\n" };
    if (cmd === "lsof") return { stdout: "p520\nn/home/test/code/billing\np720\nn/home/test/code/api\n" };
    if (cmd === "ps") return { stdout: PS };
    return null;
  };
  const watch = new AliveWatch();
  fake.window = { ...fake.window, active: false };
  await watch.tick();
  assert.equal(fake.stored[ALIVE], undefined);
  fake.window = { ...fake.window, active: true };
  await watch.tick();
  const now = fake.stored[ALIVE];
  assert.deepEqual(now.terminals.map((r) => [r.address, r.spaceId, r.ports]), [["t9", "api", [3000]]]);
  assert.deepEqual(now.outside.map((s) => [s.pid, s.ports, s.app]), [[520, [5173], "Ghostty"]]);
  fake.stored[ALIVE] = now;
  const before = fake.stored[ALIVE];
  await watch.tick();
  assert.equal(fake.stored[ALIVE], before, "the same reading is not written again");
});

test("a terminal action runs on the terminal as it is now", async () => {
  fake.terminals = [{ address: "t9", state: "live", argv: ["/bin/zsh", "-l"], pid: 710, foreground: { pid: 720, name: "node", argv: ["node", "server.mjs"] }, labels: {} }];
  await terminalAction("stop", "t9");
  assert.ok(fake.execs.includes("hc interrupt t9"));
  terminalAction("close", "t9");
  assert.deepEqual(fake.runs.at(-1), ["terminal.kill", { terminal: "t9" }]);
  assert.equal(terminalAction("open", "t404"), null);
  await flush();
});
