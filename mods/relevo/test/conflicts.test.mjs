// A PR with merge conflicts: the resolve conflicts skill, its worktree session, and the full fix as the other way.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls } from "./fake/herdr.mjs";
import { flush } from "./fake/ui.mjs";
import { mapMine } from "../lib/github.js";
import { conflictsPrompt, rankSkills } from "../lib/prmenu.js";
import { validate } from "../lib/settings.js";

const { SKILLS, launchSkill, LAUNCHED } = await import("../skills.js");

const PR = { url: "https://github.com/me/app/pull/7", number: 7, repo: "me/app", headRefName: "feat/x", isCrossRepository: false };

beforeEach(() => resetFake());

test("a conflicting PR leads with resolve conflicts", () => {
  const node = {
    number: 7, url: PR.url, isDraft: false, updatedAt: new Date().toISOString(), mergeable: "CONFLICTING", reviewDecision: null,
    repository: { nameWithOwner: "me/app" }, reviews: { nodes: [] }, reviewThreads: { nodes: [] },
    commits: { nodes: [{ commit: { committedDate: new Date().toISOString(), statusCheckRollup: { state: "FAILURE" } } }] },
  };
  const [p] = mapMine({ viewer: { login: "me", pullRequests: { nodes: [node] } } });
  assert.deepEqual(p.skills, ["conflicts", "fix"]);
  assert.match(p.reasons.join(), /merge conflict/);
});

test("the built-in prompt merges the base, asks on real decisions, and never forces", () => {
  const prompt = conflictsPrompt(PR);
  assert.match(prompt, /merge it into this branch/);
  assert.match(prompt, /stop to ask me/);
  assert.match(prompt, /never with --force/);
  assert.match(prompt, /gh pr checks 7 --watch/);
  assert.match(prompt, /push again until they're green/);
  assert.doesNotMatch(prompt, /feat\/x/);
});

test("the menu offers the full PR fix beside resolve conflicts, even unused", () => {
  assert.deepEqual(rankSkills("conflicts", SKILLS, {}, ["fix"]).map((s) => s.verb), ["conflicts", "fix"]);
});

test("resolve conflicts opens a session in a worktree of the PR's branch with the prompt", async () => {
  fake.exec = (cmd, args) => (cmd === "test" ? { code: 1 } : null);
  launchSkill(PR, "conflicts", "personal", "/work/app");
  await flush();
  assert.equal(calls(/^git -C \/work\/app worktree add --detach /).length, 1);
  assert.equal(calls(/^gh pr checkout 7 -R me\/app$/).length, 1);
  const [name, args] = fake.runs.at(-1);
  assert.equal(name, "space.new");
  assert.equal(args.tab, "app#7 · conflicts");
  assert.equal(args.name, "app #7 · resolve conflicts");
  assert.match(args.argv.join(" "), /merge conflicts with its base/);
  assert.equal(fake.stored[LAUNCHED][PR.url].skill, "conflicts");
});

test("a session that can't open says why and leaves the card as it was", async () => {
  fake.exec = (cmd) => (cmd === "test" ? { code: 0 } : null);
  launchSkill(PR, "conflicts", "personal", "/work/app");
  await flush();
  assert.match(fake.notices.at(-1).body, /already exists/);
  assert.equal(fake.stored[LAUNCHED][PR.url], undefined);
});

test("a conflicts skill in Settings is optional", () => {
  const base = { SKILLS: { review: "r", fix: "f", comments: "c" } };
  const skills = (errors) => errors.filter((e) => e.at.startsWith("skills"));
  assert.deepEqual(skills(validate(base)), []);
  assert.deepEqual(skills(validate({ SKILLS: { ...base.SKILLS, conflicts: "fix-conflicts" } })), []);
});

test("from the menu, resolve conflicts keeps the menu until the session opens, with the picked account", async () => {
  const { AccountMenu } = await import("../account-menu.js");
  const { fakeCx } = await import("./fake/ui.mjs");
  fake.exec = (cmd) => (cmd === "test" ? { code: 1 } : null);
  fake.props = { pr: PR, skill: "conflicts", folder: "/work/app", current: "personal", overlay: "o1" };
  const menu = new AccountMenu(), cx = fakeCx();
  menu.init({}, cx);
  menu.account = "work";
  menu.runSkill("conflicts", cx);
  assert.equal(menu.opening, "conflicts");
  await flush();
  assert.ok(fake.runs.some(([name]) => name === "space.new"));
  assert.equal(fake.stored[LAUNCHED][PR.url].account, "work");
});
