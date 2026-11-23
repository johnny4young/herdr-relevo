// Turning Relevo's panels on and off: the layout file, the live window and Settings.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { fake, resetFake } from "./fake/herdr.mjs";
import { fakeCx, find, flush, text } from "./fake/ui.mjs";
import { PANELS, PANELS_FILE, PANEL_KEYS, applyPanels, findNode, panelCommands, panelShown, panelsText, parsePanels, readPanels } from "../lib/panels.js";

const { Settings } = await import("../settings.js");
const LAYOUT = JSON.parse(readFileSync(new URL("../../../layouts/relevo.json", import.meta.url), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));
const HOME = "/home/test/.config/herdr-app";

beforeEach(() => resetFake());

test("every panel names blocks the shipped layout has, and none is account-status", () => {
  for (const p of PANELS) for (const id of p.nodes) assert.ok(findNode(LAYOUT, id), `${p.key}: ${id}`);
  assert.ok(!PANELS.some((p) => p.nodes.includes("account-status")), "it runs the watchers and key commands");
});

test("--only reads names, refuses typos and nothing, and all means every panel", () => {
  assert.deepEqual(parsePanels("Agents, spaces"), ["spaces", "agents"]);
  assert.deepEqual(parsePanels("all"), PANEL_KEYS);
  assert.throws(() => parsePanels("spaces,inbox"), /unknown panel inbox/);
  assert.throws(() => parsePanels(" , "), /at least one/);
  assert.deepEqual(readPanels(panelsText(["files"])), ["files"]);
  assert.deepEqual(readPanels("not json"), PANEL_KEYS);
  assert.deepEqual(readPanels(null), PANEL_KEYS);
});

test("the layout hides the blocks of panels turned off and shows them again", () => {
  const off = applyPanels(LAYOUT, ["spaces", "agents"]);
  assert.equal(findNode(off, "tabs").hidden, true);
  assert.equal(findNode(off, "inbox").hidden, true);
  assert.equal(findNode(off, "inbox-button").hidden, true);
  assert.equal(findNode(off, "spaces").hidden, undefined);
  assert.equal(findNode(LAYOUT, "tabs").hidden, undefined, "the original is untouched");
  const back = applyPanels(off, PANEL_KEYS);
  assert.ok(PANELS.every((p) => panelShown(back, p)));
  assert.equal(findNode(back, "panel-bar").hidden, true, "blocks that aren't panels keep their own state");
});

test("the window gets only the changes, and a panel showing what goes off falls back to Changes", () => {
  const tree = clone(LAYOUT);
  findNode(tree, "panel-body").active = "inbox";
  assert.deepEqual(panelCommands(tree, PANEL_KEYS), []);
  assert.deepEqual(panelCommands(tree, PANEL_KEYS.filter((k) => k !== "reviews")), [
    ["layout.hide", { id: "inbox-button" }], ["layout.hide", { id: "inbox" }],
    ["layout.select", { stack: "panel-body", child: "changes" }]]);
  findNode(tree, "files").hidden = true;
  assert.deepEqual(panelCommands(tree, PANEL_KEYS), [["layout.show", { id: "files" }]]);
});

test("Settings shows each panel as the window has it and applies the choice on save", async () => {
  fake.layout = clone(LAYOUT);
  findNode(fake.layout, "agents").hidden = true;
  const s = new Settings();
  s.init({}, fakeCx());
  assert.deepEqual(s.panels, { spaces: true, agents: false, tabs: true, files: true, reviews: true });
  s.panels.agents = true;
  s.panels.tabs = false;
  await s.applyPanels();
  assert.deepEqual(fake.runs, [["layout.show", { id: "agents" }], ["layout.hide", { id: "tabs" }]]);
  assert.deepEqual(readPanels(fake.files[`${HOME}/${PANELS_FILE}`]), ["spaces", "agents", "files", "reviews"]);
});

test("Settings leaves panels alone in a layout without Relevo's blocks", () => {
  fake.layout = { id: "root", children: [{ id: "tabs" }] };
  const s = new Settings();
  s.init({}, fakeCx());
  assert.equal(s.panels, null);
});

test("Settings ABOUT shows the installed Relevo and Herdr, and a newer release", async () => {
  fake.layout = { id: "root", children: [] };
  fake.files[`${HOME}/relevo-install/installed.json`] = JSON.stringify({ version: "0.15.2" });
  fake.exec = (cmd) => cmd === "herdr-app" ? { stdout: "herdr-app 0.1.16\n" } : cmd === "gh" ? { stdout: "v0.16.0\n" } : null;
  const s = new Settings(), cx = fakeCx();
  s.init({}, cx);
  await flush();
  const shown = s.render();
  assert.equal(text(find(shown, "settings-about-line")), "Relevo 0.15.2 · Herdr 0.1.16");
  assert.equal(text(find(shown, "settings-about-update")), "0.16.0 available: git pull --ff-only, then ./install.sh");
});

test("Settings ABOUT says nothing about updates when GitHub can't be asked", async () => {
  fake.layout = { id: "root", children: [] };
  fake.files[`${HOME}/relevo-install/installed.json`] = JSON.stringify({ version: "0.15.2" });
  fake.exec = (cmd) => cmd === "gh" ? { code: 1, stdout: "" } : null;
  const s = new Settings();
  s.init({}, fakeCx());
  await flush();
  const shown = s.render();
  assert.equal(text(find(shown, "settings-about-line")), "Relevo 0.15.2");
  assert.equal(find(shown, "settings-about-update"), null);
});
