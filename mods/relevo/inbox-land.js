// Land from the Inbox: merge a PR, follow the workflows its merge starts, then remove its worktree when nothing
// is lost. Mixed into Inbox, so `this` is the Inbox.
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { exec, notify, panes, run, shared, setShared, spaces } from "herdr";
import { ARM_MS, landLine, mergeFlag, runsPhase } from "./lib/land.js";
import { localBranch } from "./lib/prmenu.js";
import { ago } from "./lib/time.js";
import { scanWorktrees, removalCheck, removeWorktree } from "./worktrees.js";
import { headOf, logRemoval } from "./worktree-actions.js";
import { button, sectionHeader } from "./ui.js";

export const LANDING = "relevo.landing";
const TICK_MS = 20000;
// Done or failed cards stay this long, then go.
const KEPT = 86400;
const first = (r) => (r?.stderr ?? "").trim().split("\n")[0];

export class LandViews {
  startLand(cx) {
    cx.timer.every(TICK_MS, (cx) => this.landTick(cx));
  }

  landing() {
    return shared(LANDING) ?? {};
  }

  setLanding(url, entry) {
    const next = { ...this.landing() };
    if (entry) next[url] = { ...next[url], ...entry };
    else delete next[url];
    setShared(LANDING, next);
  }

  // The first click arms the button, a second within ARM_MS lands.
  armed(key) {
    return this.arming?.key === key && Date.now() - this.arming.at < ARM_MS;
  }

  arm(key, cx, go) {
    if (this.armed(key)) {
      this.arming = null;
      go();
    } else {
      this.arming = { key, at: Date.now() };
      cx.timer.after(ARM_MS + 50, (cx) => cx.notify());
    }
    cx.notify();
  }

  land(pr, auto, cx) {
    cx.spawn(async (cx) => {
      const name = `${pr.repo.split("/")[1]} #${pr.number}`;
      // The card can be minutes old: new commits since then are news to look at, not a merge error.
      const now = await exec("gh", ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "headRefOid,state"]);
      let head = null;
      try {
        head = JSON.parse(now.stdout);
      } catch {
        return notify({ title: `Could not read ${name}`, body: first(now), level: "warning" });
      }
      if (head.state !== "OPEN" || head.headRefOid !== pr.headRefOid) {
        notify({
          title: head.state !== "OPEN" ? `${name} is ${head.state.toLowerCase()}` : `${name} has new commits`,
          body: head.state !== "OPEN" ? undefined : "Nothing was merged. Look at them, then Land again.",
          level: "warning",
        });
        return this.scanPRs(cx);
      }
      const args = ["pr", "merge", String(pr.number), "--repo", pr.repo, mergeFlag(pr.repository), "--match-head-commit", pr.headRefOid];
      const r = await exec("gh", auto ? [...args, "--auto"] : args);
      if (r.code !== 0) return notify({ title: `Could not merge ${name}`, body: first(r), level: "warning" });
      this.setLanding(pr.url, {
        repo: pr.repo, number: pr.number, title: pr.title, branch: localBranch(pr), oid: pr.headRefOid,
        clone: this.clones[pr.repo] ?? null, phase: auto ? "queued" : "merging", at: Math.round(Date.now() / 1000),
      });
      await this.landTick(cx);
    });
  }

  async landTick(cx) {
    if (this.landBusy) return;
    this.landBusy = true;
    try {
      const now = Date.now() / 1000;
      for (const [url, e] of Object.entries(this.landing())) {
        if (e.phase === "landed" || e.phase === "failed") {
          if (now - (e.done ?? e.at) > KEPT) this.setLanding(url, null);
          continue;
        }
        if (e.phase === "queued" || e.phase === "merging") await this.checkMerge(url, e, cx);
        else if (e.phase === "ci") await this.checkRuns(url, e, now);
      }
    } finally {
      this.landBusy = false;
      cx.notify();
    }
  }

  async checkMerge(url, e, cx) {
    const r = await exec("gh", ["pr", "view", String(e.number), "--repo", e.repo, "--json", "state,mergeCommit,mergedAt"]);
    if (r.code !== 0) return;
    const pr = JSON.parse(r.stdout);
    if (pr.state === "MERGED") {
      this.setLanding(url, { phase: "ci", sha: pr.mergeCommit?.oid, mergedAt: Math.round(Date.parse(pr.mergedAt) / 1000) });
      this.scanPRs(cx);
    } else if (pr.state === "CLOSED") {
      this.setLanding(url, { phase: "failed", note: "Closed without merging", done: Math.round(Date.now() / 1000) });
    }
  }

  async checkRuns(url, e, now) {
    const r = await exec("gh", ["run", "list", "--repo", e.repo, "--commit", e.sha, "--json", "name,status,conclusion,url", "--limit", "30"]);
    if (r.code !== 0) return;
    const at = runsPhase(JSON.parse(r.stdout), e.mergedAt, now);
    const name = `${e.repo.split("/")[1]} #${e.number}`;
    if (at.phase === "failed") {
      notify({ title: `${at.failed.name} failed · ${name}`, body: "After the merge", level: "warning", action: { name: "relevo.panel-inbox" } });
      return this.setLanding(url, { ...at, done: Math.round(now) });
    }
    if (at.phase === "ci") return this.setLanding(url, at);
    const note = await this.cleanUp(e);
    this.setLanding(url, { ...at, note, done: Math.round(now) });
    notify({ title: `Landed · ${name}`, body: note ?? undefined, level: "success" });
  }

  // Only a worktree whose HEAD is the commit that merged, with nothing uncommitted, goes; its idle agents close with it.
  async cleanUp(e) {
    if (!e.clone || !e.branch) return null;
    const w = (await scanWorktrees(true).catch(() => [])).find((x) => x.branch === e.branch && x.main === e.clone && x.path !== x.main);
    if (!w) return null;
    if (await headOf(w) !== e.oid) return "kept its worktree: it has commits the PR doesn't";
    const inside = (p) => p.cwd === w.path || p.cwd?.startsWith(`${w.path}/`);
    if (panes().some((p) => inside(p) && p.status === "working")) return "kept its worktree: an agent is working there";
    // The worktree's own space closes with it; a resting agent's pane there from another space closes first.
    // Any other terminal there is someone's, and removalCheck keeps the worktree for it.
    const space = spaces().find((s) => !s.machine && s.folder === w.path), own = new Set((space?.tabs ?? []).map((x) => x.id));
    for (const p of panes().filter((x) => inside(x) && x.program?.agent && !own.has(x.tab))) run("pane.close", { pane: p.pane });
    const check = await removalCheck({ ...w, landed: true });
    if (check.error) return `kept its worktree: ${check.error}`;
    if (check.space) run("space.close", { id: check.space, confirmed: true });
    const err = await removeWorktree(w, e.oid);
    if (err) return `kept its worktree: ${err}`;
    await logRemoval(w, e.oid, "Land");
    return "worktree removed";
  }

  landCard(t, url, e) {
    const failed = e.phase === "failed";
    const actions = [
      ...(failed && /^https:\/\//.test(e.failed?.url ?? "") ? [button(t, `land-run-${url}`, "Open run", () => exec("open", [e.failed.url]), { kind: "solid" })] : []),
      button(t, `land-pr-${url}`, "Open PR", () => exec("open", [url])),
      ...(e.phase === "queued"
        ? [button(t, `land-cancel-${url}`, "Cancel", (cx) => this.cancelAuto(url, e, cx), { tip: "Turns auto-merge off" })]
        : []),
      ...(failed || e.phase === "landed" ? [button(t, `land-done-${url}`, "✓", () => this.setLanding(url, null), { tip: "Remove from the list" })] : []),
    ];
    // Merged in GitHub's purple.
    const dot = failed ? t.blocked : e.phase === "landed" ? t.ansi5 : t.working;
    return this.card(t, `land-${url}`, failed,
      this.head(t, dot, `${e.repo.split("/")[1]} #${e.number} · ${e.title}`, ago(e.done ?? e.at)),
      v_flex().text_size(11).text_color(failed ? t.blocked : t.muted).child(div().child(landLine(e))),
      actions);
  }

  cancelAuto(url, e, cx) {
    cx.spawn(async () => {
      const r = await exec("gh", ["pr", "merge", String(e.number), "--repo", e.repo, "--disable-auto"]);
      if (r.code !== 0) return notify({ title: "Could not turn auto-merge off", body: first(r), level: "warning" });
      this.setLanding(url, null);
    });
  }

  // Landed PRs ask nothing more, so they fold under one line; what's still landing or failed stays open.
  landingGroup(t) {
    const all = Object.entries(this.landing());
    const open = all.filter(([, e]) => e.phase !== "landed"), landed = all.filter(([, e]) => e.phase === "landed");
    const shown = this.expanded["landed"];
    return [
      ...(open.length ? [sectionHeader(t, "LANDING", open.length), ...open.map(([url, e]) => this.landCard(t, url, e))] : []),
      ...(landed.length
        ? [div().id("landed").px(4).py(2).flex().items_center().gap(5).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((s) => s.text_color(t.muted))
          .on_click((_e, cx) => {
            this.expanded["landed"] = !shown;
            cx.notify();
          })
          .child(`${shown ? "▾" : "▸"} ${landed.length} landed`)
          .child(div().size(6).rounded_full().bg(t.ansi5))]
        : []),
      ...(shown ? landed.map(([url, e]) => this.landCard(t, url, e)) : []),
    ];
  }
}
