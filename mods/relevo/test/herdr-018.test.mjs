// What Relevo takes from herdr-app 0.1.18: the palette, and timers that wait while the window can't be seen.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { fake, resetFake } from "./fake/herdr.mjs";

const { paced, unseen } = await import("../ui.js");
beforeEach(() => resetFake());

test("a paced timer: painting waits while the window can't be seen, alert work runs every n-th tick", () => {
  let paint = 0, alerts = 0;
  const p = paced(() => paint++), a = paced(() => alerts++, 3);
  for (let i = 0; i < 3; i++) { p(); a(); }
  assert.deepEqual([paint, alerts, unseen()], [3, 3, false]);
  fake.window = { ...fake.window, visible: false };
  for (let i = 0; i < 6; i++) { p(); a(); }
  assert.deepEqual([paint, alerts, unseen()], [3, 5, true]);
  fake.window = { ...fake.window, visible: true };
  p(); a();
  assert.deepEqual([paint, alerts], [4, 6]);
  // No window (herdr-app check) counts as seen.
  fake.window = null;
  assert.equal(unseen(), false);
});

test("every palette entry runs a command Relevo listens for", () => {
  const { palette } = JSON.parse(readFileSync(new URL("../mod.json", import.meta.url), "utf8"));
  const main = readFileSync(new URL("../main.js", import.meta.url), "utf8");
  assert.ok(palette.length >= 10);
  for (const entry of palette) {
    assert.match(entry.command, /^relevo\.[a-z-]+$/, entry.title);
    assert.equal(entry.args, undefined, `${entry.title}: a mod command takes no arguments`);
    const name = entry.command.slice(7);
    assert.ok(main.includes(`name === "${name}"`), `${entry.title}: main.js handles ${name}`);
  }
  assert.equal(new Set(palette.map((e) => e.command)).size, palette.length);
});
