import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { shared } from "herdr";
import { button, band, checkbox, keycap, icon, hairline, chevron, toggleFold, joined, LANE } from "./ui.js";
import { workflowCommand } from "./inbox-goals.js";
import { openGoal } from "./goals-editor.js";
import { openWorkflow } from "./workflow-window.js";
import { savedSetups, removeSetup } from "./workflow-setups.js";
import { USAGE, readReport } from "./usage-scan.js";
import { batchAlert } from "./alerts.js";
import { goalCost } from "./lib/run-cost.js";
import { count } from "./lib/run-words.js";
import { shippedPRs } from "./lib/run-panel.js";
import { decideGuard } from "./lib/workflow-navigation.js";
import { runCostLine, resumable, attemptHistory, canCompare, compareAttempts, diffFiles, batchSummary, sameRepository, thenWords } from "./lib/run-compare.js";

const SETUPS = "runs-setups";
const quiet = (t, id, words) => div().id(id).px(8).text_size(11).text_color(t.muted).child(words);
const plusMinus = (t, added, removed) => [div().flex_none().text_size(11).text_color(t.ansi2).child(`+${added}`),
  div().flex_none().text_size(11).text_color(t.ansi1).child(`−${removed}`)];

// The open run's cost, a task's attempts side by side, several results accepted at once, and the saved setups. Mixed into Inbox.
export class RunCompareViews {
  // The scanner's run spans, read again only when it has written a newer report.
  loadRunUsage(cx) {
    const key = shared(USAGE)?.updated ?? 0;
    if (this.runUsageKey === key || this.runUsageLoading) return;
    this.runUsageLoading = true;
    cx.spawn(async (cx) => {
      const report = await readReport();
      this.runSessions = Array.isArray(report?.runs) ? report.runs : [];
      this.runUsageKey = key; this.runUsageLoading = false;
      cx.notify();
    });
  }

  // Pause stops every dispatch; Resume takes back only this run's work that was under way.
  engineCommand(payloads, cx) {
    if (this.runBusy) return;
    this.runBusy = true; this.runError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        for (const payload of payloads) {
          this.takeDoc(await workflowCommand(payload));
        }
      } catch (e) { this.runError = `Action needs attention: ${e.message ?? e}`; }
      this.runBusy = false;
      this.loadGoals(cx);
      this.h.focus(); cx.notify();
    });
  }

  runCost(t, entry) {
    const { goal, items } = entry, bucket = this.runBucket(goal);
    const prs = shippedPRs(goal, this.runBucket(goal, true), items, this.mergedUrls()).size;
    const cost = runCostLine(goal, bucket, goalCost(goal, bucket.all, this.runSessions ?? []), prs), paused = resumable(bucket);
    const part = (id, meter) => div().id(id).flex_none().when(meter.over, (el) => el.font_semibold().text_color(t.blocked)).child(meter.text);
    return h_flex().id("run-cost").flex_wrap().px(8).pb(4).gap(6).items_center().text_size(11).text_color(t.muted)
      .when(cost.minutes.cap != null, (el) => el.child(div().id("run-cost-band").flex_none()
        .child(band(t, 44, cost.minutes.pct, null, { thin: true, tone: cost.minutes.over ? t.blocked : t.accent }))))
      .child(part("run-cost-minutes", cost.minutes))
      .when(Boolean(cost.tokens), (el) => el.child(div().child("·")).child(part("run-cost-tokens", cost.tokens)))
      .children(cost.rest.map((words) => div().flex_none().child(`· ${words}`)))
      .child(div().flex_1())
      .when(Boolean(this.workflowEngine?.enabled), (el) => el.child(button(t, "run-pause", "Pause automation", (cx) => this.engineCommand([{ action: "stop" }], cx),
        { kind: "ghost", size: "sm", disabled: Boolean(this.runBusy), tip: "Stops new dispatches for every run; running sessions continue" })))
      .when(paused.length > 0, (el) => el.child(button(t, "run-resume", "Resume automation",
        (cx) => this.engineCommand(paused.map((task) => ({ action: "resume", taskId: task.id })), cx),
        { kind: "ghost", size: "sm", disabled: Boolean(this.runBusy), tip: `Resumes ${count(paused.length, "paused task")} of this run` })));
  }

  // One small line per attempt: who passed to whom, how long it took and how it ended.
  attemptLines(t, task) {
    return attemptHistory(task).map((line) => div().id(`task-attempt-${task.id}-${line.n}`).min_w(0).text_size(11)
      .text_color(line.ok === false ? t.blocked : t.muted).child(line.text));
  }

  openCompare(task) {
    if (!canCompare(task)) return;
    this.runCompare = task.id; this.compareDiff = null; this.acceptIntent = null;
  }

  closeCompare() {
    this.runCompare = null; this.compareDiff = null;
  }

  // Back to where it was opened: the task, or the list with that task selected.
  leaveCompare() {
    if (!this.runTask && this.runCompare) this.sel = `task-${this.runCompare}`;
    this.closeCompare();
  }

  // What changed between the last two attempts, from their kept snapshots.
  seeAttemptDiff(task, cx) {
    const pair = compareAttempts(task).diff;
    if (!pair || this.compareDiff?.loading) return;
    this.compareDiff = { loading: true, to: pair.to }; cx.notify();
    cx.spawn(async (cx) => {
      let next;
      try { next = { to: pair.to, result: (await workflowCommand({ action: "attempt-diff", taskId: task.id, from: pair.from, to: pair.to })).result ?? {} }; }
      catch (e) { next = { to: pair.to, error: String(e.message ?? e) }; }
      if (this.runCompare === task.id) this.compareDiff = next;
      cx.notify();
    });
  }

  compareView(t, task) {
    const table = compareAttempts(task, this.runSessions ?? []);
    const diff = table.diff && this.compareDiff?.to === table.diff.to ? this.compareDiff : null;
    const tone = (cell) => (cell.quiet ? t.dim : cell.ok === false ? t.blocked : cell.ok === true ? t.done : t.foreground);
    const cell = (c, id) => h_flex().id(id).flex_1().min_w(0).gap(5).items_start()
      .when(c.ok != null, (el) => el.child(div().pt(3).flex_none().child(icon(c.ok ? "check" : "x", tone(c), 10))))
      .child(div().min_w(0).text_size(13).text_color(tone(c)).child(c.text))
      .when(c.added != null, (el) => el.children(plusMinus(t, c.added, c.removed)));
    const line = (id, label, cells) => h_flex().id(id).px(8).py(5).gap(8).items_start()
      .child(div().w(84).flex_none().pt(1).text_size(11).text_color(t.dim).child(label)).children(cells);
    const files = diff?.result ? diffFiles(diff.result) : null;
    return [
      line("compare-head", "", table.columns.map((column) => div().flex_1().min_w(0).text_size(11).text_color(t.dim).child(column.label.toUpperCase()))),
      ...table.rows.flatMap((item) => [hairline(t, 0), line(`compare-${item.key}`, item.label, item.cells.map((c, i) => cell(c, `compare-${item.key}-${table.columns[i].n}`)))]),
      ...(table.diff ? [h_flex().px(8).pt(8).child(button(t, "compare-diff-open", "See what changed between them", (cx) => this.seeAttemptDiff(task, cx),
        { disabled: Boolean(diff?.loading), tip: `Attempt ${table.columns.at(-2).n} against attempt ${table.columns.at(-1).n}` }))] : []),
      ...(diff?.loading ? [quiet(t, "compare-diff-loading", "Reading the two snapshots…")] : []),
      ...(diff?.error ? [quiet(t, "compare-diff-error", diff.error)] : []),
      ...(files ? [v_flex().id("compare-diff").px(8).pt(4).gap(2)
        .child(h_flex().gap(6).items_center().text_size(11).text_color(t.muted).child(div().child(files.head)).children(plusMinus(t, files.added, files.removed)))
        .children(files.list.map((file, i) => h_flex().id(`compare-file-${i}`).gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(13).tooltip(file.path).child(file.path))
          .children(file.binary ? [div().flex_none().text_size(11).text_color(t.dim).child("binary")] : plusMinus(t, file.added, file.removed))))
        .when(files.more > 0, (el) => el.child(div().id("compare-diff-more").text_size(11).text_color(t.dim).child(`+${files.more} more`)))] : []),
    ];
  }

  // The results selected for one acceptance, as they are now.
  pickedTasks(goal) {
    return this.runBucket(goal).me.filter((task) => this.runPicked.includes(task.id));
  }

  togglePick(task) {
    if (task.state !== "needs_you" || this.runBusy) return;
    this.runPicked = this.runPicked.includes(task.id) ? this.runPicked.filter((id) => id !== task.id) : [...this.runPicked, task.id];
  }

  pickRepository(goal, anchor) {
    if (anchor && !this.runBusy) this.runPicked = sameRepository(anchor, this.runBucket(goal).me).map((task) => task.id);
  }

  // A selection with an unapproved or failing result arms on the first press; it is armed only for these ids.
  batchArmed(picked) {
    return this.runBatchArm === picked.map((task) => task.id).sort().join(" ");
  }

  // The window's batch: a preview of these ids at these revisions, then the same ids and revisions applied.
  acceptPicked(goal, cx) {
    const picked = this.pickedTasks(goal), summary = batchSummary(picked);
    if (this.runBusy || this.workflowError || !summary.ok || !picked.every((task) => decideGuard(task, this.workflowTasks))) return;
    if (!summary.clean && !this.batchArmed(picked)) {
      this.runBatchArm = picked.map((task) => task.id).sort().join(" ");
      return cx.notify();
    }
    this.runBatchArm = null;
    const ids = picked.map((task) => task.id), revisions = Object.fromEntries(picked.map((task) => [task.id, task.revision]));
    this.runBusy = true; this.runError = null; this.runNotice = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const preview = (await workflowCommand({ action: "batch", ids, outcome: "accept", revisions, preview: true })).preview ?? [];
        if (preview.length !== ids.length || preview.some((item) => !ids.includes(item.taskId))) throw Error("The preview does not match the selection");
        const response = await workflowCommand({ action: "batch", ids: preview.map((item) => item.taskId), outcome: "accept", revisions, preview: false });
        this.takeDoc(response);
        batchAlert(picked, goal.id);
        this.runPicked = [];
        this.runNotice = `${count(ids.length, "result")} accepted: ${picked.map((task) => task.title).join(", ")}.`;
        const next = this.orderedTasks(goal, false)[0];
        this.sel = next ? `task-${next.id}` : null;
      } catch (e) { this.runError = `Action needs attention: ${e.message ?? e}`; }
      this.runBusy = false;
      this.loadGoals(cx);
      this.h.focus(); cx.notify();
    });
  }

  pickBox(t, task) {
    const on = this.runPicked.includes(task.id);
    return button(t, `task-pick-${task.id}`, [checkbox(t, on)], (cx) => { this.togglePick(task); this.h.focus(); cx.notify(); },
      { kind: "ghost", size: "sm", selected: on, accessibleLabel: `${on ? "Selected" : "Not selected"}: ${task.title}`, tip: "x" });
  }

  // What sits past the Needs me header: the hint, or the repository of the selection.
  pickHint(t, goal) {
    const summary = batchSummary(this.pickedTasks(goal));
    if (this.runPicked.length) return [div().id("run-pick-scope").flex_none().text_color(t.muted).child(summary.repository ? `same repository: ${summary.repository}` : "more than one repository")];
    return this.runBucket(goal).me.length > 1 ? [h_flex().id("run-pick-hint").flex_none().gap(4).text_color(t.muted).items_center().child(keycap(t, "x")).child(div().child("select"))] : [];
  }

  batchBar(t, goal) {
    const picked = this.pickedTasks(goal), n = picked.length, summary = batchSummary(picked);
    return h_flex().id("runs-batch").flex_none().pl(16).pr(8).py(5).gap(8).items_center().border_t(1).border_color(t.border).bg(t.raised)
      .child(div().flex_none().font_semibold().text_size(13).child(`${n} selected`))
      .child(div().id("runs-batch-why").flex_1().min_w(0).truncate().text_size(11).text_color(summary.clean ? t.muted : t.blocked).tooltip(summary.text).child(summary.text))
      .child(button(t, "runs-batch-cancel", [keycap(t, "esc"), "Cancel"], (cx) => { this.runPicked = []; this.h.focus(); cx.notify(); }, { size: "sm", kind: "ghost" }))
      .child(button(t, "runs-batch-accept", [keycap(t, "enter"), this.batchArmed(picked) ? `Accept ${n} anyway` : `Accept ${n}`], (cx) => this.acceptPicked(goal, cx),
        { size: "sm", kind: "accent", disabled: !summary.ok || Boolean(this.runBusy),
          tip: !summary.ok ? summary.text : summary.clean || this.batchArmed(picked) ? "Accepts each result at the revision on screen" : `${summary.text}: press again to accept` }));
  }

  thenReason(task, goal) {
    return thenWords(task, this.runBucket(goal).all, this.workflowEngine);
  }

  // The saved setups, open in place: Start fills the run window's new task with one, and nothing is sent.
  setupsFold(t, target) {
    const items = savedSetups(), open = Boolean(this.expanded[SETUPS]);
    if (!items.length) return [];
    const start = (item) => (target ? openWorkflow(target.goal.id, null, { setup: item.id }) : openGoal());
    return [
      h_flex().id("runs-setups").min_h(28).pl(LANE).pr(8).gap(5).items_center().text_size(11).text_color(t.dim)
        .child(chevron(open)).child(div().flex_1().child(`Saved setups · ${items.length}`))
        .child(button(t, "runs-setups-show", open ? "Hide" : "Show", (cx) => toggleFold(this, SETUPS, cx), { size: "sm" })),
      ...(open ? joined(t, items.map((item) => h_flex().id(`setup-${item.id}`).min_h(38).py(4).pl(LANE).pr(8).gap(8).items_center()
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().min_w(0).truncate().font_semibold().text_size(13).child(item.name))
          .child(div().min_w(0).truncate().text_size(11).text_color(t.muted).tooltip(item.root)
            .child(`${item.root.split("/").pop()} · ${item.executor.label ?? item.executor.address} + ${item.reviewer.label ?? item.reviewer.address} · ${count(item.maxRounds, "attempt")}`)))
        .child(button(t, `setup-start-${item.id}`, "Start", () => start(item),
          { size: "sm", tip: target ? `A new task in "${target.goal.title}" with this setup; nothing starts until you create it` : "A new run" }))
        .child(button(t, `setup-remove-${item.id}`, [icon("x")], (cx) => { removeSetup(item.id); cx.notify(); },
          { size: "sm", kind: "ghost", accessibleLabel: `Remove the setup ${item.name}`, tip: "Removes only this saved setup" })))) : []),
    ];
  }
}
