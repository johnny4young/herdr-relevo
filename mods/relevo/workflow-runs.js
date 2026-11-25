import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, terminals, exec, appHome, notify, run, panes, shared, setShared, spaces } from "herdr";
import { runtimeCommand } from "./runtime-cli.js";
import { button } from "./ui.js";
import * as config from "./config.js";
import { accountOf, runnableAccounts, chip, launchArgv, openInFolder, loadClaudeQuotas, full, providerFor } from "./accounts.js";
import { WorkflowDraftView } from "./workflow-draft-view.js";
import { accountFor } from "./context.js";
import { RUN_LAUNCH, answerTrust, launchSteps, ownFolderKeys, reportsFolder, repoChecks, runTab, trustKeys } from "./run-launch.js";
import { launchStepsView } from "./deep-review-view.js";
import { runFolder } from "./lib/run-folder.js";
import { checksText, parseChecks } from "./lib/run-checks.js";
import { REMOVE_TIMEOUT } from "./worktrees.js";


// The repository a folder belongs to: a run's own worktree gives the repository it was made from.
export async function repoOf(cwd) {
  if (!runFolder(cwd)) return cwd;
  const r = await exec("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => null);
  const common = r?.code === 0 ? r.stdout.trim().replace(/\/+$/, "") : "";
  return common.endsWith("/.git") ? common.slice(0, -5) : cwd;
}

export { trustKeys };

const RUN_ACCOUNTS = "relevo.runs.accounts";

// Who writes and who reviews a new run: the last choice, unless that account is out of quota now; else a provider that
// writes first (Codex, when it is on), and a reviewer other than the writer, the repository's own account first.
export function runAccountsFor(root, quotas) {
  const saved = shared(RUN_ACCOUNTS) ?? {};
  const all = runnableAccounts().map((account) => account.key);
  const open = (key) => all.includes(key) && !full(quotas?.[key]);
  const executor = open(saved.executor) ? saved.executor : [...all.filter((key) => providerFor(key).caps.writer), ...all].find(open) ?? all[0];
  const reviewer = open(saved.reviewer) && saved.reviewer !== executor ? saved.reviewer
    : [accountFor(root), ...all].find((key) => key && key !== executor && open(key)) ?? all.find((key) => key !== executor);
  return { executor, reviewer };
}
// The name of the tab a terminal is shown in, if any.
const tabName = (address) => {
  const tab = panes().find((pane) => pane.terminal === address)?.tab;
  return spaces().flatMap((space) => space.tabs ?? []).find((item) => item.id === tab)?.name ?? null;
};
const LAUNCH_TIMEOUT = 180000;
// Codex asks to update before it starts; Esc is its own "skip" and changes nothing.
export const codexUpdatePrompt = (screen) => /Update available · \S+ → \S+/.test(screen) && /esc skip/.test(screen);

// Agents write only their checkout and the reports folder, each by its own CLI's flags (lib/providers.js).
// RUN_SANDBOX = true also keeps Bash in the OS sandbox, where builds that need the network or a cache outside the
// checkout (SwiftPM, a first npm install) fail.
export const runAgentArgs = (key, role, home) => providerFor(key).runArgs({ role, home, sandboxed: config.RUN_SANDBOX === true, config });

export class WorkflowRuns extends WorkflowDraftView {
  loadQuotas(cx) {
    cx.spawn(async (cx) => {
      try { this.quotas = await loadClaudeQuotas(); } catch { this.quotas = {}; }
      if (!this.closed) cx.notify();
    });
  }

  runAccounts() {
    return runAccountsFor(this.form.root.value().trim(), this.quotas);
  }

  // One line per role: the label, then each account as its colored letter, its name and how full its quota is.
  accountPicker(t, role, label) {
    const chosen = this.runAccounts(), other = chosen[role === "executor" ? "reviewer" : "executor"];
    return h_flex().w_full().min_w(0).gap(8).items_center()
      .child(div().w(80).flex_none().text_size(11).text_color(t.dim).child(label))
      .child(h_flex().flex_1().min_w(0).flex_wrap().gap(4).children(runnableAccounts().map((account) => {
        const q = this.quotas?.[account.key], pct = q ? Math.round(Math.max(q.h5?.pct ?? 0, q.d7?.pct ?? 0)) : null, on = chosen[role] === account.key, taken = other === account.key;
        return h_flex().id(`workflow-${role}-account-${account.key}`).h(28).px(8).gap(6).items_center().rounded(7).border_1()
          .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background)
          .when(!taken, (el) => el.cursor_pointer().hover((st) => st.border_color(t.accent))
            .on_click((_e, cx) => { setShared(RUN_ACCOUNTS, { ...chosen, [role]: account.key }); cx.notify(); }))
          .when(taken, (el) => el.opacity(0.4).tooltip("Already chosen for the other role"))
          .child(chip(div, account, 16)).child(div().text_size(13).text_color(full(q) ? t.dim : t.foreground).child(account.label))
          .when(pct !== null, (el) => el.child(div().text_size(11).text_color(pct >= 90 ? t.blocked : t.dim).child(`${pct}%`)));
      })));
  }

  // The terminal of a role that has not started, to open its tab and answer what it asks.
  launchTerminal(role) {
    const l = this.launch;
    return l?.worktree ? terminals().find((k) => k.cwd === l.worktree.path && tabName(k.address) === l.tabs?.[role]) ?? null : null;
  }

  keepWaiting(cx) {
    if (!this.launch) return;
    Object.assign(this.launch, { stage: "waiting", at: Date.now(), readAt: 0 });
    this.busy = true; cx.notify();
  }

  // Gives up a start: its worktree has no work yet, so it goes with its run branch.
  cancelLaunch(cx) {
    const l = this.launch;
    if (!l) return;
    this.launch = null; this.launchNotice = null; this.busy = false; this.error = null; this.shareLaunch(null);
    const opened = new Set(Object.values(l.tabs ?? {}));
    for (const tab of spaces().flatMap((space) => space.tabs ?? []).filter((tab) => opened.has(tab.name))) run("tab.close", { id: tab.id, confirmed: true });
    if (l.worktree) cx.spawn(async () => {
      await exec("git", ["-C", l.worktree.base, "worktree", "remove", l.worktree.path], { timeout: REMOVE_TIMEOUT }).catch(() => null);
      await exec("git", ["-C", l.worktree.base, "branch", "-D", l.worktree.branch]).catch(() => null);
    });
    cx.notify();
  }

  // While a run starts, or stalls, this card stands in for the form: each step, why one waits, and the way on.
  launchCard(t) {
    const l = this.launch, steps = this.launchStepsNow() ?? [], stalled = l.stage === "stalled", failed = l.stage === "failed";
    const stuckRole = !l.ready?.executor ? "executor" : null, term = stuckRole && this.launchTerminal(stuckRole);
    const why = l.trust ? "asks whether to trust the run's worktree" : l.stuck ? "waits on a question in its tab" : stalled ? "has not started yet" : null;
    return v_flex().id("workflow-launch-card").w_full().min_w(0).gap(12).p(14).rounded(10).bg(t.raised)
      .child(div().font_semibold().child(`${failed ? "Did not start" : stalled ? "Still starting" : "Starting"} · ${l.fields.title}`))
      .when(failed, (el) => el.child(div().id("workflow-launch-failure").text_size(13).text_color(t.blocked).child(l.failure)))
      .child(launchStepsView(t, "workflow-launch-steps", steps.map((s, i) => (i === 1 && stuckRole && why ? { ...s, note: `${s.note} · ${why}` } : s))))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .when(Boolean(l.trust), (bar) => bar.child(button(t, "workflow-launch-trust", "Trust and continue", (cx) => this.trustLaunch(cx), { kind: "solid" })))
        .when(Boolean(term), (bar) => bar.child(button(t, "workflow-launch-open", "Open its tab", () => run("agent.focus", { terminal: term.address }),
          { kind: l.trust ? "outline" : "solid", tip: "Answer it there; the start goes on by itself" })))
        .when(stalled, (bar) => bar.child(button(t, "workflow-launch-wait", "Keep waiting", (cx) => this.keepWaiting(cx))))
        .when(failed, (bar) => bar.child(button(t, "workflow-launch-again", "Start again", (cx) => this.create(cx, { start: true }), { kind: "solid", tip: "Asks the coordinator again with the same writer" })))
        .child(div().flex_1())
        .child(button(t, "workflow-launch-cancel", "Cancel start", (cx) => this.cancelLaunch(cx), { kind: "ghost", tip: "Removes the new worktree and its branch; nothing was written there" })));
  }

  // A worktree run: create the checkout, open its writer beside the repo's tabs, then start once it is ready.
  // The reviewer opens when the review comes (openReviewer), as for a run started from the Inbox.
  launchWorktreeRun(fields, cx) {
    const accounts = this.runAccounts();
    this.busy = true; this.error = null; this.launch = { stage: "preparing", fields, accounts, at: Date.now() }; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const pr = this.prTarget?.root === fields.root ? this.prTarget : null;
        const result = await runtimeCommand({ action: "prepare-worktree", root: fields.root, title: fields.title, ...(pr ? { pr: { headRef: pr.headRef } } : {}) });
        const response = JSON.parse(result.stdout || "{}");
        if (response.error || result.code !== 0) throw Error(response.error || result.stderr || "Could not create the worktree");
        this.launch = { ...this.launch, stage: "waiting", worktree: response.result, prUrl: pr?.url ?? null, tabs: { executor: runTab("executor", response.result.branch) } };
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
          const own = ownFolderKeys(screen, reportsFolder());
          if (own) { await exec("hc", ["keys", k.address, ...own]); continue; }
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
  // Where the start is: the worktree, then each agent, the one waiting on a question marked.
  launchStepsNow() {
    const l = this.launch;
    if (!l) return null;
    const labels = [["Worktree", l.worktree?.branch ?? l.fields.root.split("/").pop()], ["Writer", accountOf(l.accounts.executor).label], ["Reviewer", `${accountOf(l.accounts.reviewer).label} · opens to review`]];
    const at = l.stage === "preparing" ? 0 : !l.ready?.executor ? 1 : 2;
    return launchSteps(labels, at, Boolean(l.trust || l.stuck));
  }

  shareLaunch(words) {
    const launch = this.launch, next = launch && words ? { goalId: launch.fields.goalId, words, trust: launch.trust ?? null, at: launch.at, steps: this.launchStepsNow() } : null;
    if (JSON.stringify(shared(RUN_LAUNCH) ?? null) !== JSON.stringify(next)) setShared(RUN_LAUNCH, next);
  }

  launchTick(cx) {
    this.refreshWorktreeInfo(cx);
    if (this.composing()) this.detectChecks(cx);
    const launch = this.launch;
    if (this.closed || !launch?.worktree) return;
    if (["stalled", "failed"].includes(launch.stage)) return;
    if (Date.now() - launch.at > LAUNCH_TIMEOUT) {
      launch.stage = "stalled"; this.busy = false; this.launchNotice = null; this.shareLaunch(null); cx.notify(); return;
    }
    if (launch.stage !== "waiting") return;
    const inTree = (agent) => terminals().find((k) => k.address === agent.address)?.cwd === launch.worktree.path;
    const found = Object.fromEntries(["executor"].map((role) => {
      const named = agents().filter((agent) => agent.tab_name === launch.tabs[role]);
      return [role, named.find(inTree) ?? named[0]];
    }));
    // The coordinator waits for a free agent itself; here an agent only has to exist and not wait on a prompt.
    const waiting = Object.entries(found).filter(([, agent]) => !agent || !["idle", "done", "working"].includes(agent.status));
    const stuck = waiting.find(([, agent]) => agent?.status === "blocked" || (!agent && Date.now() - launch.openedAt > 10000));
    launch.ready = Object.fromEntries(Object.entries(found).map(([role, agent]) => [role, Boolean(agent && ["idle", "done", "working"].includes(agent.status))]));
    launch.stuck = Boolean(stuck);
    if (stuck && !stuck[1]) this.skipUpdatePrompts(launch, found, cx);
    const notice = launch.trust ? `“${launch.trust.tab ?? "A run agent"}” asks whether to trust the run's worktree before it starts.`
      : stuck ? `Answer the prompt in “${launch.tabs[stuck[0]]}” to continue.` : `Opening ${accountOf(launch.accounts.executor).label}…`;
    if (this.launchNotice !== notice) { this.launchNotice = notice; cx.notify(); }
    this.shareLaunch(notice);
    if (waiting.length) return;
    this.shareLaunch(null);
    this.launch = null; this.launchNotice = null; this.busy = false;
    const label = (role) => accountOf(launch.accounts[role]).label;
    this.command({ action: "create", start: true, task: { ...launch.fields, root: launch.worktree.path,
      executor: { address: found.executor.address, label: label("executor") }, reviewLater: { account: launch.accounts.reviewer, label: label("reviewer") },
      worktree: { branch: launch.worktree.branch, base: launch.worktree.base, baseCommit: launch.worktree.baseCommit, baseBranch: launch.worktree.baseBranch,
        ...(launch.worktree.prHead ? { prHead: launch.worktree.prHead, prUrl: launch.prUrl } : {}) } } }, cx, (response) => {
      this.explicitNew = false; this.selected = response.result?.taskId ?? null; this.filter = "In progress";
    }, (error) => {
      // The writer is open and waiting: the card says why the run did not start, and a toast says it wherever you are.
      const failure = String(error.message ?? error);
      this.launch = { ...launch, stage: "failed", failure }; this.error = null;
      notify({ title: `“${launch.fields.title}” did not start`, body: failure, level: "error" });
    });
  }
}
