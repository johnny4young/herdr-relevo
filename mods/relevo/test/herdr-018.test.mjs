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

test("a click on a PR of a repository cloned here opens Review; anything else goes to the browser", async () => {
  const { handleLink } = await import("../link.js");
  const { REPOS_ROOT } = await import("../config.js");
  const clone = `/home/test/${REPOS_ROOT}/app`;
  const remotes = { [clone]: "origin\tgit@github.com:me/app.git (fetch)\nupstream\thttps://github.com/acme/app.git (fetch)\n" };
  fake.exec = (cmd, args) => {
    const line = args.join(" ");
    if (cmd === "git" && line.endsWith("remote -v")) return remotes[args[1]] ? { code: 0, stdout: remotes[args[1]] } : { code: 128, stdout: "" };
    if (cmd === "gh" && line.startsWith("pr view 7 -R acme/app")) {
      return { code: 0, stdout: JSON.stringify({ number: 7, url: "https://github.com/acme/app/pull/7", baseRefName: "main", headRefName: "fix", isCrossRepository: false }) };
    }
    if (cmd === "git" && line.includes("worktree list")) return { code: 0, stdout: `worktree ${clone}\nbranch refs/heads/fix\n\n` };
    if (cmd === "git" && line.includes("--show-toplevel")) return { code: 0, stdout: `${clone}\n` };
    return { code: 0, stdout: "" };
  };
  const click = (url, machine = null) => handleLink({ link: { kind: "url", raw: url, url }, source: { terminal: "t1", machine } });
  assert.equal(await click("https://github.com/acme/app/pull/7/files"), "handled");
  const split = fake.runs.find(([name]) => name === "pane.split");
  assert.equal(split[1].props.role, "review-diff");
  assert.deepEqual([split[1].props.pr.repo, split[1].props.pr.number], ["acme/app", 7]);
  assert.equal(await click("https://github.com/acme/app/issues/7"), "pass");
  assert.equal(await click("https://github.com/other/lib/pull/3"), "pass", "not cloned here");
  assert.equal(await click("https://github.com/acme/app/pull/7", "devbox"), "pass", "another machine's terminal");
});

test("Attach files lists the picked files once each under Files:", async () => {
  const { withFiles } = await import("../lib/goals.js");
  assert.equal(withFiles("Fix the login", ["/a/x.png"]), "Fix the login\n\nFiles:\n- /a/x.png");
  assert.equal(withFiles("Fix the login\n\nFiles:\n- /a/x.png", ["/a/x.png", "/b/y.log"]), "Fix the login\n\nFiles:\n- /a/x.png\n- /b/y.log");
  assert.equal(withFiles("", ["/a/x.png"]), "Files:\n- /a/x.png");
  assert.equal(withFiles("Files: are named in the spec", ["/a"]), "Files: are named in the spec\n\nFiles:\n- /a");
});
