import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, exec, appHome, run, shared, setShared, spaces } from "herdr";
import { button } from "./ui.js";
import * as config from "./config.js";
import { ACCOUNTS, CODEX, accountOf, launchArgv, openInFolder, loadClaudeQuotas, full } from "./accounts.js";
import { WorkflowDraftView } from "./workflow-draft-view.js";
import { accountFor } from "./context.js";
import { row } from "./workflow-labels.js";

const RUN_ACCOUNTS = "relevo.runs.accounts";
const LAUNCH_TIMEOUT = 180000;

// Agents write only their checkout and the reports folder. Codex gets that from workspace-write; Claude runs
// Bash in the OS sandbox and its file tools may not edit the app (its state, locks, mods or settings).
export function runAgentArgs(key, role, home) {
  const reports = `${home}/relevo-workflow/reports`;
  if (key === CODEX.key) return ["-m", config.RUN_CODEX_MODEL ?? "gpt-6-luna", "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "--add-dir", reports];
  // A bare "*" would also match the reports folder: app files all carry an extension, folders are listed.
  const deny = ["*.*", "relevo-workflow/*.*", ...["mods", "data", "layouts", "themes", "icons", "frame", "telemetry", "relevo-workflow/artifacts", "relevo-workflow/archive"].map((dir) => `${dir}/**`)]
    .map((glob) => `Edit(/${home}/${glob})`);
  const settings = { sandbox: { enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true }, permissions: { deny } };
  return ["--add-dir", reports, "--permission-mode", "acceptEdits", "--settings", JSON.stringify(settings), ...(role === "reviewer" ? ["--tools", "Read,Write,Grep,Glob"] : [])];
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
    const all = [...ACCOUNTS, CODEX].map((account) => account.key);
    const open = (key) => all.includes(key) && !full(this.quotas?.[key]);
    const executor = all.includes(saved.executor) ? saved.executor : [CODEX.key, ...all].find(open) ?? CODEX.key;
    const repoAccount = accountFor(this.form.root.value().trim());
    const reviewer = all.includes(saved.reviewer) && saved.reviewer !== executor ? saved.reviewer
      : [repoAccount, ...all].find((key) => key && key !== executor && open(key)) ?? all.find((key) => key !== executor);
    return { executor, reviewer };
  }

  accountPicker(t, role, label) {
    const chosen = this.runAccounts();
    return v_flex().w_full().min_w(0).gap(4).child(row(t, label))
      .child(h_flex().flex_wrap().gap(4).children([...ACCOUNTS, CODEX].map((account) => button(t, `workflow-${role}-account-${account.key}`,
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
        const result = await exec("node", [`${appHome()}/mods/relevo/runtime/cli.mjs`, "--home", appHome(), "command", JSON.stringify({ action: "prepare-worktree", root: fields.root, title: fields.title })]);
        const response = JSON.parse(result.stdout || "{}");
        if (response.error || result.code !== 0) throw Error(response.error || result.stderr || "Could not create the worktree");
        const slug = response.result.branch.replace(/^run\//, "");
        this.launch = { ...this.launch, stage: "opening", worktree: response.result, tabs: { executor: `${slug} · build`, reviewer: `${slug} · review` } };
        openInFolder({ name: fields.root.split("/").pop(), folder: response.result.path, tab: this.launch.tabs.executor, argv: launchArgv(accounts.executor, null, runAgentArgs(accounts.executor, "executor", appHome())) });
        this.launch.openedAt = Date.now();
      } catch (error) {
        if (!this.closed) { this.launch = null; this.busy = false; this.error = `Could not start the run: ${error.message ?? error}`; }
      }
      if (!this.closed) cx.notify();
    });
  }

  // A finished run's worktree state is read once per task and again after each worktree action.
  refreshWorktreeInfo(cx) {
    const task = this.tasks?.find((item) => item.id === this.selected);
    if (!task?.worktree || !["accepted", "cancelled"].includes(task.state) || task.worktree.removed || this.busy) return;
    this.worktreeInfo ??= {};
    if (this.worktreeInfo[task.id] !== undefined) return;
    this.worktreeInfo[task.id] = null;
    this.command({ action: "worktree-status", taskId: task.id }, cx, (response) => { this.worktreeInfo[task.id] = response.result ?? { exists: false }; });
  }

  worktreeAction(task, action, cx) {
    if (action === "worktree-remove") {
      const slug = task.worktree.branch.replace(/^run\//, "");
      for (const tab of spaces().flatMap((space) => space.tabs ?? []).filter((tab) => tab.name.startsWith(`${slug} · `))) run("tab.close", { id: tab.id, confirmed: true });
    }
    this.command({ action, taskId: task.id }, cx, () => { delete this.worktreeInfo?.[task.id]; });
  }

  worktreePanel(t, task) {
    const wt = task.worktree, info = this.worktreeInfo?.[task.id];
    const gone = wt.removed || info?.exists === false, cancelled = task.state === "cancelled";
    const state = gone ? "worktree removed" : !info ? "checking…" : info.dirty ? "uncommitted changes" : wt.commit ? `committed ${wt.commit.slice(0, 7)}` : info.ahead ? `${info.ahead} commits` : "no changes";
    const canPropose = !cancelled && !gone && info && !info.dirty && info.ahead !== 0 && !wt.pr;
    return v_flex().id("workflow-worktree").w_full().min_w(0).gap(6).p(10).rounded(8).bg(t.raised)
      .child(div().text_size(11).text_color(t.muted).truncate().child(`${wt.branch} · ${state}`))
      .child(h_flex().gap(6).flex_wrap()
        .when(Boolean(wt.pr), (el) => el.child(button(t, "workflow-worktree-open-pr", "Open PR", () => exec("open", [wt.pr]), { kind: "solid", tip: wt.pr })))
        .when(canPropose, (el) => el.child(button(t, "workflow-worktree-pr", "Open draft PR", (cx) => this.worktreeAction(task, "worktree-pr", cx), { kind: "solid", disabled: this.busy, tip: "Pushes the run branch and opens a draft PR" })))
        .when(cancelled && !gone && Boolean(info), (el) => el.child(button(t, "workflow-worktree-discard", "Discard worktree", (cx) => this.worktreeAction(task, "worktree-remove", cx),
          { kind: "ghost", disabled: this.busy, tip: info?.dirty ? "Closes its tabs and deletes the worktree with its uncommitted changes" : "Closes its tabs and removes the worktree" })))
        .when(!cancelled && !gone && Boolean(info) && !info.dirty, (el) => el.child(button(t, "workflow-worktree-remove", "Remove worktree", (cx) => this.worktreeAction(task, "worktree-remove", cx),
          { kind: "ghost", disabled: this.busy, tip: info?.ahead === 0 ? "Closes its tabs and removes the worktree and its empty branch" : "Closes its tabs and removes the worktree; the branch stays" }))));
  }

  launchTick(cx) {
    this.refreshWorktreeInfo(cx);
    const launch = this.launch;
    if (this.closed || !launch?.worktree) return;
    if (launch.stage === "stalled") return;
    if (Date.now() - launch.at > LAUNCH_TIMEOUT) {
      launch.stage = "stalled"; this.busy = false; this.launchNotice = null;
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
    const notice = stuck ? `Answer the prompt in “${launch.tabs[stuck[0]]}” to continue.` : `Starting agents · ${2 - waiting.length}/2 ready`;
    if (this.launchNotice !== notice) { this.launchNotice = notice; cx.notify(); }
    if (waiting.length) return;
    this.launch = null; this.launchNotice = null; this.busy = false;
    const label = (role) => accountOf(launch.accounts[role]).label;
    this.command({ action: "create", start: true, task: { ...launch.fields, root: launch.worktree.path,
      executor: { address: found.executor.address, label: label("executor") }, reviewer: { address: found.reviewer.address, label: label("reviewer") },
      worktree: { branch: launch.worktree.branch, base: launch.worktree.base, baseCommit: launch.worktree.baseCommit, baseBranch: launch.worktree.baseBranch } } }, cx, (response) => {
      this.explicitNew = false; this.selected = response.result?.taskId ?? null; this.filter = "In progress";
    });
  }
}
