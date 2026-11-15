import "./fake/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { URL } from "node:url";
import { find, text, click, fakeCx } from "./fake/ui.mjs";

const ui = await import("../ui.js");
const t = new Proxy({}, { get: (_x, name) => (typeof name === "string" ? `#${name}` : undefined) });
const all = (node, pick, out = []) => {
  if (node && typeof node === "object") {
    if (pick(node)) out.push(node);
    for (const child of node.items ?? []) all(child, pick, out);
  }
  return out;
};
const svgs = (node) => all(node, (n) => n.kind === "svg").map((n) => n.src);

test("every glyph is a 12 px currentColor file, and every file is listed", () => {
  const dir = new URL("../icons/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4)).sort();
  assert.deepEqual(files, [...ui.ICONS].sort());
  for (const name of files) {
    const body = readFileSync(new URL(`${name}.svg`, dir), "utf8");
    assert.match(body, /viewBox="0 0 12 12"/, name);
    assert.match(body, /stroke="currentColor"/, name);
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b/i, `${name} carries its own colour`);
  }
  assert.equal(ui.icon("pr", t.muted).src, "mods/relevo/icons/pr.svg");
});

test("each turn has its own glyph, and none of them is a leading strip", () => {
  assert.equal(ui.laneGlyph(t, "me").fill, t.blocked);
  assert.equal(ui.laneGlyph(t, "flight").spinning, true);
  assert.equal(ui.laneGlyph(t, "ready").src, "mods/relevo/icons/check.svg");
  assert.equal(ui.laneGlyph(t, "open").stroke, t.accent);
  assert.equal(ui.laneGlyph(t, "old").fill, t.idle);
  assert.equal(ui.laneGlyph(t, "stuck").src, "mods/relevo/icons/warn.svg");
});

test("a row reads lane, kind, what, why, age and its one action", () => {
  let picked = 0;
  const action = ui.button(t, "fix", "Fix CI", () => {});
  const el = ui.row(t, "row-142", { turn: "me", kind: "pr", title: "billing #142", reason: "CI failing: unit", age: "1h", action, onSelect: () => { picked += 1; } });
  assert.equal(text(el), "billing #142 CI failing: unit 1h Fix CI");
  assert.deepEqual(svgs(el), ["mods/relevo/icons/pr.svg"]);
  assert.equal(el.fill, ui.meTint(t), "a row waiting on you is tinted");
  click(el, fakeCx());
  assert.equal(picked, 1);
  assert.ok(find(el, "fix"));
});

test("a selected row is outlined and opens its extra lines; others stay one line", () => {
  const quiet = ui.row(t, "r1", { turn: "flight", title: "web #43", reason: "CI running" });
  assert.equal(quiet.fill, null);
  assert.equal(quiet.items.length, 1);
  const open = ui.row(t, "r2", { turn: "ready", title: "web #40", selected: true, below: ["lint, build and e2e passed"] });
  assert.equal(open.stroke, t.accent);
  assert.equal(open.fill, t.selected);
  assert.match(text(open), /lint, build and e2e passed/);
});

test("the counters are the legend, and a section header carries its count", () => {
  const legend = ui.legend(t, "legend", [{ turn: "me", n: 6 }, { turn: "flight", n: 2 }, { turn: "ready", n: 2 }]);
  assert.equal(text(legend), "Needs me 6 In flight 2 Ready 2");
  assert.equal(text(ui.legHeader(t, "leg-me", "Needs me", 6, { me: true })), "NEEDS ME 6");
});

test("a key bar lists its keys and keeps help at the far edge", () => {
  const bar = ui.keyBar(t, "keys", [[["j", "k"], "move"], [["enter"], "do the action"]], [["?"], "all keys"]);
  assert.equal(text(bar), "j k move do the action ? all keys");
  assert.deepEqual(svgs(bar), ["mods/relevo/icons/enter.svg"]);
});

test("micro charts: check boxes, diff squares, age ticks, relay legs and a usage band", () => {
  assert.deepEqual(ui.seg(t, ["ok", "bad", "run", "wait"]).items.map((i) => i.fill), [t.done, t.blocked, t.working, t.raised]);
  assert.deepEqual(ui.diffRatio(t, 48, 6).items.map((i) => i.fill), [t.ansi2, t.ansi2, t.ansi2, t.ansi2, t.ansi1]);
  assert.deepEqual(ui.diffRatio(t, 0, 0).items.map((i) => i.fill), Array(5).fill(t.raised));
  assert.deepEqual(ui.ageTicks(t, 2 * 3600e3).items.map((i) => i.fill), [t.dim, t.dim, t.dim, t.dim, t.border]);
  const relay = ui.legs(t, [{ label: "Luna", state: "ok" }, { label: "Haiku", state: "ok" }, { label: "You", state: "you" }]);
  assert.equal(text(relay), "Luna Haiku You");
  assert.equal(ui.legs(t, [{ label: "Luna", state: "ok" }], { bare: true }).items[0].items.length, 1);
  const full = ui.band(t, 100, 99, 0.5);
  assert.equal(full.items[1].fill, t.blocked);
  assert.equal(ui.band(t, 100, 30).items[1].fill, t.accent);
  assert.equal(ui.tag(t, "CI failing", t.blocked).fill, `${t.blocked}26`);
  assert.equal(ui.checkbox(t, true).fill, t.accent);
});

test("colours come from the theme: no view hard-codes one", () => {
  for (const mod of ["relevo", "relevo-agents", "relevo-files", "relevo-tabs"]) {
    const dir = new URL(`../../${mod}/`, import.meta.url);
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".js") && !/^config(\.example)?\.js$/.test(f) && f !== "settings.js")) {
      assert.doesNotMatch(readFileSync(new URL(name, dir), "utf8"), /["'`]#[0-9a-f]{6}([0-9a-f]{2})?["'`]/i, `${mod}/${name}`);
    }
  }
});

test("the one action of a row that waits on you is filled in its colour", () => {
  assert.equal(ui.button(t, "go", "Answer", () => {}, { kind: "go" }).fill, t.blocked);
  assert.equal(ui.button(t, "ac", "Accept", () => {}, { kind: "accent" }).fill, t.accent);
  assert.equal(ui.button(t, "more", [ui.icon("more", t.muted)], () => {}, { accessibleLabel: "More actions" }).accessibleLabel, "More actions");
  assert.equal(ui.hairline(t).fill, t.border);
});

test("a fold shows which way it points, and an icon label is read by its words", () => {
  const view = { expanded: {} };
  assert.equal(ui.foldRow(view, t, "f", "k", "3 addressed").items[0].src, "mods/relevo/icons/chevron-right.svg");
  view.expanded.k = true;
  assert.equal(ui.foldRow(view, t, "f", "k", "3 addressed").items[0].src, "mods/relevo/icons/chevron-down.svg");
  assert.equal(ui.button(t, "s", [ui.chevron(false, t.muted), "Saved setups · 2"], () => {}).accessibleLabel, "Saved setups · 2");
  assert.equal(ui.button(t, "r", [ui.icon("refresh", t.muted)], () => {}, { tip: "Read again" }).accessibleLabel, "Read again");
  assert.equal(ui.quotaTone(t, 80), t.blocked);
  assert.equal(ui.quotaTone(t, 50), t.ansi3);
});
