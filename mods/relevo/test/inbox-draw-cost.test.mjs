// One draw of Reviews does its per-PR work once, so a long PR list doesn't redraw quadratically.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "./fake/herdr.mjs";
import { fakeCx, flush } from "./fake/ui.mjs";

const { Inbox } = await import("../inbox.js");
beforeEach(resetFake);

const NOW = new Date().toISOString();
const pr = (n) => ({ url: `https://github.com/acme/app/pull/${n}`, number: n, repo: "acme/app", title: `PR ${n}`, reasons: ["CI failing"], skills: ["fix", "review"], updatedAt: NOW });

async function draws(rows) {
  const inbox = new Inbox(), cx = fakeCx();
  inbox.init({}, cx);
  await flush();
  inbox.clones["acme/app"] = "/work/app";
  inbox.mine = Array.from({ length: rows }, (_, i) => pr(i + 1));
  let sources = 0, buttons = 0;
  const goalSources = inbox.goalSources.bind(inbox), skillButton = inbox.skillButton.bind(inbox);
  inbox.goalSources = (v) => { sources += 1; return goalSources(v); };
  inbox.skillButton = (...args) => { buttons += 1; return skillButton(...args); };
  inbox.render(cx);
  return { sources, buttons };
}

test("a draw finds the run sources once, not once per PR row", async () => {
  const few = await draws(3), many = await draws(40);
  assert.equal(many.sources, few.sources);
  assert.ok(many.sources <= 3, `${many.sources} passes over every source`);
});

test("a closed row builds only the action it shows, not every skill button", async () => {
  const { buttons } = await draws(40);
  assert.equal(buttons, 40, "one shown action per row, two skills each");
});
