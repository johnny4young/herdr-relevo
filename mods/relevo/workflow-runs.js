import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, terminals, exec, appHome, run, panes, shared, setShared, spaces } from "herdr";
import { runtimeCommand } from "./runtime-cli.js";
import { button } from "./ui.js";
import * as config from "./config.js";
import { CODEX, accountOf, agentAccounts, codexOn, launchArgv, openInFolder, loadClaudeQuotas, full } from "./accounts.js";
import { WorkflowDraftView } from "./workflow-draft-view.js";
import { accountFor } from "./context.js";
import { row } from "./workflow-labels.js";
import { RUN_LAUNCH, answerTrust, repoChecks, trustKeys } from "./run-launch.js";
import { runFolder } from "./lib/run-folder.js";
import { checksText, parseChecks } from "./lib/run-checks.js";


// The repository a folder belongs to: a run's own worktree gives the repository it was made from.
export async function repoOf(cwd) {
  if (!runFolder(cwd)) return cwd;
  const r = await exec("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => null);
  const common = r?.code === 0 ? r.stdout.trim().replace(/\/+$/, "") : "";
  return common.endsWith("/.git") ? common.slice(0, -5) : cwd;
}

export { trustKeys };

const RUN_ACCOUNTS = "relevo.runs.accounts";
// The name of the tab a terminal is shown in, if any.
const tabName = (address) => {
  const tab = panes().find((pane) => pane.terminal === address)?.tab;
  return spaces().flatMap((space) => space.tabs ?? []).find((item) => item.id === tab)?.name ?? null;
};
const LAUNCH_TIMEOUT = 180000;
// Codex asks to update before it starts; Esc is its own "skip" and changes nothing.
export const codexUpdatePrompt = (screen) => /Update available · \S+ → \S+/.test(screen) && /esc skip/.test(screen);

// Agents write only their checkout and the reports folder. Codex gets that from workspace-write; Claude runs
// A run agent's file tools may not edit the app (its state, locks, mods or settings). It works in auto mode in its
// own worktree; RUN_SANDBOX = true also keeps its Bash in the OS sandbox, where builds that need the network or a
// cache outside the checkout (SwiftPM, a first npm install) fail.
export function runAgentArgs(key, role, home) {
  const reports = `${home}/relevo-workflow/reports`;
  // A Codex reviewer never asks: what its hooks or global instructions start outside the sandbox fails and it goes on
  // reviewing. Its hooks can't be turned off here: that would ask to restart Codex's shared server for every session.
  const sandboxed = config.RUN_SANDBOX === true;
  if (key === CODEX.key) return ["-m", config.RUN_CODEX_MODEL ?? "gpt-6-luna", "--sandbox", role === "executor" && !sandboxed ? "danger-full-access" : "workspace-write",
    "--ask-for-approval", role === "reviewer" ? "never" : "on-request", "--add-dir", reports];
  // A bare "*" would also match the reports folder: app files all carry an extension, folders are listed.
  const deny = ["*.*", "relevo-workflow/*.*", ...["mods", "data", "layouts", "themes", "icons", "frame", "telemetry", "relevo-workflow/artifacts", "relevo-workflow/archive"].map((dir) => `${dir}/**`)]
    .map((glob) => `Edit(/${home}/${glob})`);
  // Its status and report files are written without asking; nothing else is granted.
  const settings = { ...(sandboxed ? { sandbox: { enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true, autoAllowBashIfSandboxed: true } } : {}),
    // A Claude reviewer starts without the person's hooks: one that asks for something else pulls it off the review.
    permissions: { allow: [`Edit(/${reports}/*.json)`], deny }, ...(role === "reviewer" ? { disableAllHooks: true } : {}) };
  return ["--add-dir", reports, "--permission-mode", "auto", "--settings", JSON.stringify(settings), ...(role === "reviewer" ? ["--tools", "Read,Write,Grep,Glob"] : [])];
}

export class WorkflowRuns extends WorkflowDraftView {
  loadQuotas(cx) {
    cx.spawn(async (cx) => {
      try { this.quotas = await loadClaudeQuotas(); } catch { this.quotas = {}; }
      if (!this.closed) cx.notify();
    });
  }

  runAccounts() {
    const saved = shared(RUN_ACCOUNTS) ?? {};
    const all = agentAccounts().map((account) => account.key);
    const open = (key) => all.includes(key) && !full(this.quotas?.[key]);
    // The last choice, unless that account is out of quota now.
    const executor = open(saved.executor) ? saved.executor : [...(codexOn() ? [CODEX.key] : []), ...all].find(open) ?? all[0];
    const repoAccount = accountFor(this.form.root.value().trim());
    const reviewer = open(saved.reviewer) && saved.reviewer !== executor ? saved.reviewer
      : [repoAccount, ...all].find((key) => key && key !== executor && open(key)) ?? all.find((key) => key !== executor);
    return { executor, reviewer };
  }

  accountPicker(t, role, label) {
    const chosen = this.runAccounts();
    return v_flex().w_full().min_w(0).gap(4).child(row(t, label))
      .child(h_flex().flex_wrap().gap(4).children(agentAccounts().map((account) => button(t, `workflow-${role}-account-${account.key}`,
        full(this.quotas?.[account.key]) ? `${account.label} · ${full(this.quotas[account.key])} full` : account.label,
        (cx) => { setShared(RUN_ACCOUNTS, { ...chosen, [role]: account.key }); cx.notify(); },
        { kind: "ghost", size: "sm", selected: chosen[role] === account.key, disabled: chosen[role === "executor" ? "reviewer" : "executor"] === account.key }))));
  }

  // A worktree run: create the checkout, open both agents beside the repo's tabs, then start once both are ready.
  launchWorktreeRun(fields, cx) {
    const accounts = this.runAccounts();
    this.busy = true; this.error = null; this.launch = { stage: "preparing", fields, accounts, at: Date.now() }; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const pr = this.prTarget?.root === fields.root ? this.prTarget : null;
        const result = await runtimeCommand({ action: "prepare-worktree", root: fields.root, title: fields.title, ...(pr ? { pr: { headRef: pr.headRef } } : {}) });
        const response = JSON.parse(result.stdout || "{}");
        if (response.error || result.code !== 0) throw Error(response.error || result.stderr || "Could not create the worktree");
        const slug = response.result.branch.replace(/^run\//, "");
        this.launch = { ...this.launch, stage: "opening", worktree: response.result, prUrl: pr?.url ?? null, tabs: { executor: `${slug} · build`, reviewer: `${slug} · review` } };
        openInFolder({ name: fields.root.split("/").pop(), folder: response.result.path, tab: this.launch.tabs.executor, argv: launchArgv(accounts.executor, null, runAgentArgs(accounts.executor, "executor", appHome())) });
        this.launch.openedAt = Date.now();
      } catch (error) {
        if (!this.closed) { this.launch = null; this.busy = false; this.error = `Could not start the run: ${error.message ?? error}`; }
      }
      if (!this.closed) cx.notify();
    });
  }

  // A new task's tests start as what its repository declares, until the person picks them or a past setup does.
  detectChecks(cx) {
    const root = this.form.root.value().trim();
    if (!root.startsWith("/") || this.checksFor === root || this.checksPicked) return;
    this.checksFor = root;
    cx.spawn(async (cx) => {
      const checks = await repoChecks(root);
      if (this.closed || this.checksFor !== root || this.checksPicked) return;
      this.useChecks(checks);
      cx.notify();
    });
  }

  useChecks(checks) {
    const npm = checks.length === 1 && checks[0].length === 2 && checks[0][0] === "npm" && checks[0][1] === "test";
    this.checkPreset = !checks.length ? "none" : npm ? "npm-test" : "custom";
    this.form.checks.set_value(this.checkPreset === "custom" ? checksText(checks) : "");
  }

  // The checks the form holds now, as the coordinator will get them; null when the custom ones don't parse.
  checksNow() {
    if (this.checkPreset === "npm-test") return [["npm", "test"]];
    if (this.checkPreset !== "custom") return [];
    try { const checks = parseChecks(this.form.checks.value()); return Array.isArray(checks) ? checks : null; } catch { return null; }
  }

  // A finished run's worktree state is read once per task and again after each worktree action.
  refreshWorktreeInfo(cx) {
    const task = this.tasks?.find((item) => item.id === this.selected);
    if (!task?.worktree || !["accepted", "cancelled"].includes(task.state) || task.worktree.removed || this.busy) return;
    this.worktreeInfo ??= {};
    if (this.worktreeInfo[task.id] !== undefined) return;
    this.worktreeInfo[task.id] = null;
    // Not through command(): a status read neither holds the window busy nor clears its error.
    cx.spawn(async (cx) => {
      let result = null;
      try { result = JSON.parse((await runtimeCommand({ action: "worktree-status", taskId: task.id })).stdout || "{}").result ?? null; } catch { /* said below */ }
      this.worktreeInfo[task.id] = result ?? { failed: true };
      cx.notify();
    });
  }

  worktreeAction(task, action, cx) {
    if (action === "worktree-remove") {
      const slug = task.worktree.branch.replace(/^run\//, "");
      for (const tab of spaces().flatMap((space) => space.tabs ?? []).filter((tab) => tab.name.startsWith(`${slug} · `))) run("tab.close", { id: tab.id, confirmed: true });
    }
    this.command({ action, taskId: task.id }, cx, () => { delete this.worktreeInfo?.[task.id]; });
  }

  worktreePanel(t, task) {
    const wt = task.worktree, read = this.worktreeInfo?.[task.id], info = read?.failed ? null : read;
    const gone = wt.removed || info?.exists === false, cancelled = task.state === "cancelled";
    const state = wt.pushed ? `pushed to ${wt.prHead} · ${wt.pushed.slice(0, 7)}` : gone ? "worktree removed" : read?.failed ? "could not read its state" : !info ? "checking…" : info.dirty ? "uncommitted changes" : wt.commit ? `committed ${wt.commit.slice(0, 7)}` : info.ahead ? `${info.ahead} commits` : "no changes";
    const canCommit = !cancelled && !gone && Boolean(info?.dirty) && !wt.commit;
    const canPropose = !cancelled && !gone && info && !info.dirty && info.ahead !== 0 && info.origin !== false && !wt.pr && !wt.prHead;
    const canPush = !cancelled && !gone && info && !info.dirty && info.ahead !== 0 && Boolean(wt.prHead) && !wt.pushed;
    return v_flex().id("workflow-worktree").w_full().min_w(0).gap(6).p(10).rounded(8).bg(t.raised)
      .child(div().text_size(11).text_color(t.muted).truncate().child(`${wt.branch} · ${state}`))
      .child(h_flex().gap(6).flex_wrap()
        .when(Boolean(read?.failed), (el) => el.child(button(t, "workflow-worktree-reread", "Read again", (cx) => { delete this.worktreeInfo[task.id]; cx.notify(); })))
        .when(Boolean(wt.pr), (el) => el.child(button(t, "workflow-worktree-open-pr", "Open PR", () => exec("open", [wt.pr]), { kind: "solid", tip: wt.pr })))
        .when(canPush, (el) => el.child(button(t, "workflow-worktree-push", `Push to ${wt.prHead}`, (cx) => this.worktreeAction(task, "worktree-push", cx),
          { kind: "solid", disabled: this.busy, tip: `Adds the accepted commit to the pull request's branch on GitHub; never forced, so a branch that moved refuses it` })))
        .when(canPropose, (el) => el.child(button(t, "workflow-worktree-pr", "Open draft PR", (cx) => this.worktreeAction(task, "worktree-pr", cx), { kind: "solid", disabled: this.busy, tip: "Pushes the run branch and opens a draft PR" })))
        .when(canCommit, (el) => el.child(button(t, "workflow-worktree-commit", "Commit accepted changes", (cx) => this.worktreeAction(task, "worktree-commit", cx),
          { kind: "solid", disabled: this.busy, tip: "The acceptance was saved but its commit did not land; this commits the accepted revision" })))
        .when(cancelled && !gone && Boolean(info), (el) => el.child(button(t, "workflow-worktree-discard", "Discard worktree", (cx) => this.worktreeAction(task, "worktree-remove", cx),
          { kind: "ghost", disabled: this.busy, tip: info?.dirty ? "Closes its tabs and deletes the worktree with its uncommitted changes" : "Closes its tabs and removes the worktree" })))
        .when(!cancelled && !gone && Boolean(info) && !info.dirty, (el) => el.child(button(t, "workflow-worktree-remove", "Remove worktree", (cx) => this.worktreeAction(task, "worktree-remove", cx),
          { kind: "ghost", disabled: this.busy, tip: info?.ahead === 0 ? "Closes its tabs and removes the worktree and its empty branch" : "Closes its tabs and removes the worktree; the branch stays" }))));
  }

  // A run terminal that never became an agent may be sitting on Codex's update prompt: skip it, once per terminal.
  // A trust question is noted for the person to answer with Trust and continue.
  skipUpdatePrompts(launch, found, cx) {
    if (launch.reading || Date.now() - (launch.readAt ?? 0) < 5000) return;
    const known = new Set(Object.values(found).filter(Boolean).map((agent) => agent.address));
    launch.skipped ??= new Set();
    const waiting = terminals().filter((k) => k.cwd === launch.worktree.path && !known.has(k.address) && !launch.skipped.has(k.address));
    if (!waiting.length) { if (launch.trust) { launch.trust = null; cx.notify(); } return; }
    launch.reading = true; launch.readAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        let trust = null;
        for (const k of waiting) {
          const screen = (await exec("hc", ["read", k.address, "--lines", "30"])).stdout ?? "";
          const keys = trustKeys(screen);
          if (keys) trust ??= { address: k.address, keys, tab: tabName(k.address) };
          if (!codexUpdatePrompt(screen)) continue;
          launch.skipped.add(k.address);
          await exec("hc", ["keys", k.address, "esc"]);
        }
        if (JSON.stringify(trust) !== JSON.stringify(launch.trust ?? null)) { launch.trust = trust; cx.notify(); }
      } catch { /* the notice still asks for the prompt to be answered */ }
      launch.reading = false;
    });
  }

  // The person's yes to the trust question of a run agent; the next tick reads its screen again.
  trustLaunch(cx) {
    const trust = this.launch?.trust;
    if (!trust) return;
    this.launch.trust = null; this.launch.readAt = 0;
    cx.spawn(async (cx) => {
      await answerTrust(trust.address);
      cx.notify();
    });
  }

  // Starting a run moves the person to its new space, away from this window: Runs shows what the launch waits on.
  shareLaunch(words) {
    const launch = this.launch, next = launch && words ? { goalId: launch.fields.goalId, words, trust: launch.trust ?? null, at: launch.at } : null;
    if (JSON.stringify(shared(RUN_LAUNCH) ?? null) !== JSON.stringify(next)) setShared(RUN_LAUNCH, next);
  }

  launchTick(cx) {
    this.refreshWorktreeInfo(cx);
    if (this.composing()) this.detectChecks(cx);
    const launch = this.launch;
    if (this.closed || !launch?.worktree) return;
    if (launch.stage === "stalled") return;
    if (Date.now() - launch.at > LAUNCH_TIMEOUT) {
      launch.stage = "stalled"; this.busy = false; this.launchNotice = null; this.shareLaunch(null);
      this.error = `The agents are not ready yet. Start keeps waiting on ${launch.worktree.branch}.`; cx.notify(); return;
    }
    if (launch.stage === "opening" && Date.now() - launch.openedAt > 1500) {
      openInFolder({ name: launch.fields.root.split("/").pop(), folder: launch.worktree.path, tab: launch.tabs.reviewer, argv: launchArgv(launch.accounts.reviewer, null, runAgentArgs(launch.accounts.reviewer, "reviewer", appHome())) });
      launch.stage = "waiting";
    }
    if (launch.stage !== "waiting") return;
    const found = Object.fromEntries(["executor", "reviewer"].map((role) => [role, agents().find((agent) => agent.tab_name === launch.tabs[role])]));
    // The coordinator waits for a free agent itself; here an agent only has to exist and not wait on a prompt.
    const waiting = Object.entries(found).filter(([, agent]) => !agent || !["idle", "done", "working"].includes(agent.status));
    const stuck = waiting.find(([, agent]) => agent?.status === "blocked" || (!agent && Date.now() - launch.openedAt > 10000));
    if (stuck && !stuck[1]) this.skipUpdatePrompts(launch, found, cx);
    const notice = launch.trust ? `“${launch.trust.tab ?? "A run agent"}” asks whether to trust the run's worktree before it starts.`
      : stuck ? `Answer the prompt in “${launch.tabs[stuck[0]]}” to continue.` : `Starting agents · ${2 - waiting.length}/2 ready`;
    if (this.launchNotice !== notice) { this.launchNotice = notice; cx.notify(); }
    this.shareLaunch(notice);
    if (waiting.length) return;
    this.shareLaunch(null);
    this.launch = null; this.launchNotice = null; this.busy = false;
    const label = (role) => accountOf(launch.accounts[role]).label;
    this.command({ action: "create", start: true, task: { ...launch.fields, root: launch.worktree.path,
      executor: { address: found.executor.address, label: label("executor") }, reviewer: { address: found.reviewer.address, label: label("reviewer") },
      worktree: { branch: launch.worktree.branch, base: launch.worktree.base, baseCommit: launch.worktree.baseCommit, baseBranch: launch.worktree.baseBranch,
        ...(launch.worktree.prHead ? { prHead: launch.worktree.prHead, prUrl: launch.prUrl } : {}) } } }, cx, (response) => {
      this.explicitNew = false; this.selected = response.result?.taskId ?? null; this.filter = "In progress";
    });
  }
}
