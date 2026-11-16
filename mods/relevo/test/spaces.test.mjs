// The Spaces sidebar: one row per repo under its folder, worktrees under their checkout, and the order ⌃1…⌃9 follow.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls } from "./fake/herdr.mjs";
import { fakeCx, find, flush, text } from "./fake/ui.mjs";

const { default: Spaces } = await import("../../relevo-spaces/main.js");
const { buildModel, movesTo, branchNote, where } = await import("../../relevo-spaces/model.js");
const { folderFor, compileRule } = await import("../../relevo-spaces/folders.js");
const { readGit } = await import("../../relevo-spaces/git.js");

const FOLDERS = {
  list: [
    { id: "work", name: "Work", color: "ansi4", path: "~/code", match: "acme-api, acme-web" },
    { id: "personal", name: "Personal", color: "ansi2", path: "~/code", match: "~" },
  ],
  of: {},
};
const space = (id, name, cwd, over = {}) => ({ id, name, folder: cwd, machine: null, active: false, status: null, tabs: [{ id: `tb-${id}` }], ...over });
const pane = (id, cwd) => ({ pane: `p-${id}`, terminal: `t-${id}`, tab: `tb-${id}`, cwd, program: { shell: true } });
const repo = (dir, over = {}) => ({ name: dir.split("/").pop(), branch: "main", ahead: 0, behind: 0, changed: 0, repo: JSON.stringify([null, `${dir}/.git`]), gitDir: `${dir}/.git`, linked: false, ...over });

beforeEach(() => resetFake());

test("folder rules take bare repo names anywhere in the path and ~ paths from home", () => {
  assert.ok(compileRule("acme-api").test("/home/test/code/acme-api/src"));
  assert.equal(compileRule("acme-api").test("/home/test/code/acme-api-old"), false);
  assert.ok(compileRule("~").test("/Users/me/code/x"));
  assert.ok(compileRule("~/code/client-*").test("/home/test/code/client-a"));
  assert.equal(folderFor("sp1", "/home/test/code/acme-web", FOLDERS).id, "work");
  assert.equal(folderFor("sp1", "/home/test/code/blog", FOLDERS).id, "personal");
  assert.equal(folderFor("sp1", "/home/test/code/acme-web", { ...FOLDERS, of: { sp1: "personal" } }).id, "personal");
});

test("spaces group by folder in the folders' order, and the order lists every space as shown", () => {
  const spaces = [space("a", "blog", "/home/test/code/blog"), space("b", "acme-api", "/home/test/code/acme-api"), space("c", "notes", "/home/test/notes")];
  const m = buildModel({ spaces, panes: [], folders: FOLDERS });
  assert.deepEqual(m.groups.map((g) => [g.id, g.rows.map((r) => r.w.id)]), [["work", ["b"]], ["personal", ["a", "c"]]]);
  assert.deepEqual(m.order, ["b", "a", "c"]);
});

test("a worktree's space sits under its checkout, in the checkout's folder, wherever it was made", () => {
  const spaces = [space("wt", "fix-login", "/home/test/wt/fix-login"), space("main", "acme-api", "/home/test/code/acme-api")];
  const git = {
    [where(spaces[0], [])]: repo("/home/test/wt/fix-login", { branch: "fix-login", linked: true, repo: JSON.stringify([null, "/home/test/code/acme-api/.git"]) }),
    [where(spaces[1], [])]: repo("/home/test/code/acme-api"),
  };
  const m = buildModel({ spaces, panes: [], git, folders: FOLDERS });
  assert.deepEqual(m.groups[0].rows.map((r) => [r.w.id, r.tree]), [["main", null], ["wt", "last"]]);
  assert.deepEqual(m.order, ["main", "wt"]);
});

test("a space follows its first terminal's live folder", () => {
  const spaces = [space("a", "acme-api", "/home/test")];
  const m = buildModel({ spaces, panes: [pane("a", "/home/test/code/acme-api")], folders: FOLDERS });
  assert.equal(m.groups.find((g) => g.rows.length).id, "work");
});

test("moves count the ones before them", () => {
  assert.deepEqual(movesTo(["a", "b", "c"], ["c", "a", "b"]), [{ id: "c", index: 1 }]);
  assert.deepEqual(movesTo(["a", "b", "c"], ["a", "b", "c"]), []);
  assert.deepEqual(movesTo(["a", "b", "c", "d"], ["d", "c", "a", "b"]), [{ id: "d", index: 1 }, { id: "c", index: 2 }]);
});

test("the branch shows only when unusual", () => {
  assert.equal(branchNote(repo("/x"), "x"), null);
  assert.equal(branchNote(repo("/x", { branch: "feat/limits" }), "x"), "feat/limits");
  assert.equal(branchNote(repo("/x", { branch: "spike" }), "Spike"), null);
  assert.equal(branchNote(repo("/x", { branch: null }), "x"), "detached");
  assert.equal(branchNote(null, "x"), null);
});

test("git is read without optional locks or the repo's own programs, and its counts and changed files come back", async () => {
  fake.exec = (cmd, args) => {
    const a = args.join(" ");
    if (a.includes("--show-toplevel")) return { stdout: "/home/test/code/acme-api\n" };
    if (a.includes("--git-common-dir")) return { stdout: "/home/test/code/acme-api/.git\n" };
    if (a.includes("symbolic-ref")) return { stdout: "refs/heads/feat/limits\n" };
    if (a.includes("rev-list")) return { stdout: "2\t1\n" };
    if (a.includes("status")) return { stdout: " M a.js\n?? b.js\n" };
    return null;
  };
  const g = await readGit("/home/test/code/acme-api");
  assert.deepEqual({ name: g.name, branch: g.branch, ahead: g.ahead, behind: g.behind, changed: g.changed, linked: g.linked }, { name: "acme-api", branch: "feat/limits", ahead: 2, behind: 1, changed: 2, linked: false });
  const reads = calls(/^git /);
  assert.ok(reads.length >= 5 && reads.every((line) => line.startsWith("git --no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false -c diff.external= ")), reads.join("\n"));
  assert.match(reads.find((line) => line.includes(" status ")), /--ignore-submodules=all/);
});

test("not a repo is remembered; a git that can't answer is asked again", async () => {
  fake.exec = () => ({ code: 128, stderr: "fatal: not a git repository" });
  assert.equal(await readGit("/home/test/notes"), null);
  fake.exec = () => ({ code: 1, stderr: "connection lost" });
  await assert.rejects(readGit("/home/test/notes"));
});

async function open(spaces, panes = []) {
  fake.spaces = spaces;
  fake.panes = panes;
  fake.stored["space-folders"] = { "": JSON.parse(JSON.stringify(FOLDERS)) };
  fake.exec = (cmd, args, options) => {
    const a = args.join(" "), cwd = options?.cwd ?? "";
    if (a.includes("--show-toplevel")) return { stdout: `${cwd}\n` };
    if (a.includes("--git-common-dir")) return { stdout: `${cwd}/.git\n` };
    if (a.includes("symbolic-ref")) return { stdout: cwd.endsWith("acme-api") ? "refs/heads/feat/limits\n" : "refs/heads/main\n" };
    if (a.includes("rev-list")) return { stdout: cwd.endsWith("acme-api") ? "3\t0\n" : "0\t0\n" };
    if (a.includes("status")) return { stdout: cwd.endsWith("blog") ? " M a\n M b\n" : "" };
    return null;
  };
  const mod = new Spaces(), cx = fakeCx();
  mod.init({}, cx);
  cx.fire(500);
  await flush();
  return { mod, cx, ui: () => mod.render(cx) };
}

test("each folder heads its spaces, and a row says its unusual branch, ahead count and changed files", async () => {
  const { ui } = await open([space("a", "blog", "/home/test/code/blog"), space("b", "acme-api", "/home/test/code/acme-api")]);
  const shown = text(ui());
  assert.ok(shown.indexOf("WORK") < shown.indexOf("acme-api") && shown.indexOf("acme-api") < shown.indexOf("PERSONAL"), shown);
  assert.match(text(find(ui(), "space-b")), /feat\/limits ↑3/);
  assert.match(text(find(ui(), "space-a")), /±2/);
  assert.doesNotMatch(text(find(ui(), "space-a")), /main/);
});

test("the spaces move so ⌃1…⌃9 follow the list", async () => {
  const { ui } = await open([space("a", "blog", "/home/test/code/blog"), space("b", "acme-api", "/home/test/code/acme-api")]);
  ui();
  assert.deepEqual(fake.runs.filter(([n]) => n === "space.move").map(([, a]) => a), [{ id: "b", index: 1 }]);
  ui();
  assert.equal(fake.runs.filter(([n]) => n === "space.move").length, 1, "the same move is not sent again before its echo");
});

test("dropping a space on another folder puts it there", async () => {
  const { mod, cx, ui } = await open([space("b", "acme-api", "/home/test/code/acme-api"), space("a", "blog", "/home/test/code/blog")]);
  const row = find(ui(), "space-a");
  row.handlers["on_mouse_down:left"]({}, cx);
  const head = find(ui(), "folder-work");
  head.handlers.on_mouse_move({}, cx);
  head.handlers["on_mouse_up:left"]({}, cx);
  assert.equal(fake.stored["space-folders"][""].of.a, "work");
  assert.equal(mod.pressed, null);
});

test("a click on a row shows its space; a click on a folder folds it", async () => {
  const { cx, ui } = await open([space("a", "blog", "/home/test/code/blog")]);
  const row = find(ui(), "space-a");
  row.handlers["on_mouse_down:left"]({}, cx);
  row.handlers["on_mouse_up:left"]({}, cx);
  assert.deepEqual(fake.runs.at(-1), ["space.select", { id: "a" }]);
  find(ui(), "folder-personal").handlers.on_click({}, cx);
  assert.equal(fake.stored["space-folders"][""].list.find((f) => f.id === "personal").folded, true);
  assert.equal(find(ui(), "space-a"), null);
});

test("a new folder goes before the default one, and a context's folder can't be deleted", async () => {
  fake.stored["space-folders"] = { "": JSON.parse(JSON.stringify(FOLDERS)) };
  fake.stored["relevo.setup"] = { contexts: [{ key: "personal" }, { key: "work" }] };
  fake.props = { editFolder: null, overlay: 7 };
  const cx = fakeCx(), editor = new Spaces();
  editor.init({}, cx);
  editor.name.type("Clients", cx);
  editor.match.type("client-*", cx);
  find(editor.render(cx), "folder-save").handlers.on_click({}, cx);
  const list = fake.stored["space-folders"][""].list;
  assert.deepEqual(list.map((f) => f.name), ["Work", "Clients", "Personal"]);
  assert.equal(list[1].match, "client-*");
  assert.deepEqual(fake.closedOverlays, [7]);
  fake.props = { folderMenu: "work" };
  const menu = new Spaces();
  menu.init({}, cx);
  assert.equal(find(menu.render(cx), "folder-delete"), null);
  fake.props = { folderMenu: list[1].id };
  assert.ok(find(menu.render(cx), "folder-delete"));
});

test("a drag let go outside the list ends when the pointer leaves it", async () => {
  const { mod, cx, ui } = await open([space("a", "blog", "/home/test/code/blog"), space("b", "acme-api", "/home/test/code/acme-api")]);
  Object.assign(mod, { pressed: "a", over: "x" });
  find(ui(), "spaces-list").handlers.on_hover(false, cx);
  assert.deepEqual([mod.pressed, mod.over], [null, null]);
  mod.pressed = null;
  find(ui(), "spaces-list").handlers.on_hover(false, cx);
  assert.equal(mod.pressed, null, "leaving without a drag changes nothing");
});
