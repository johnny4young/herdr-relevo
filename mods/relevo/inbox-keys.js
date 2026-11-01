import { run, exec, focused, shared, setShared } from "herdr";
import { pickAccount } from "./accounts.js";
import { openReview } from "./review.js";
import { launchSkill } from "./skills.js";
import { showPanel } from "./toolbar.js";
import { recent } from "./lib/github.js";

// A request to focus the Inbox, with the pane to give the keyboard back to on Esc.
export const INBOX_FOCUS = "relevo.inbox.focus";

export function focusInbox() {
  showPanel("inbox");
  setShared(INBOX_FOCUS, { at: Date.now(), pane: focused()?.pane ?? null });
}

// ↑/↓ pick a card or row and Enter runs its main action. Mixed into Inbox, so `this` is the Inbox.
export class KeyNav {
  // The selectable items in screen order, each with what Enter does.
  navItems(v) {
    const items = [];
    for (const i of v.local.filter((x) => x.kind === "blocked")) {
      items.push({ id: `in-${i.agent.address}`, go: () => run("agent.focus", { terminal: i.agent.address }) });
    }
    for (const i of v.local.filter((x) => x.kind === "diff")) {
      items.push({ id: `in-${i.agent.address}`, go: () => openReview(i.top, i.agent.address) });
    }
    for (const [key, list] of [["mine", v.mine], ["requested", v.requested]]) {
      const shownPRs = [...list.filter(recent), ...(this.expanded[key] ? list.filter((p) => !recent(p)) : [])];
      for (const pr of shownPRs) items.push({ id: `pr-${pr.url}`, go: () => this.runPR(pr) });
    }
    for (const w of v.worktrees.filter((x) => x.merged)) items.push({ id: `wt-${w.path}`, go: () => this.openTree(w) });
    if (this.expanded.loose) {
      for (const w of v.worktrees.filter((x) => !x.merged && !x.open)) {
        items.push({ id: `loose-${w.path}`, go: () => this.openTree(w) });
      }
    }
    return items;
  }

  // Its agent if one runs, else the suggested skill when the repo is cloned, else the PR on GitHub.
  runPR(pr) {
    const agent = this.prAgents[pr.url], folder = this.clones[pr.repo];
    if (agent) return run("agent.focus", { terminal: agent.address });
    if (folder && pr.skills?.length) {
      launchSkill(pr, pr.skills[0], pickAccount(pr.repo, this.quotas).key, folder);
      return this.publish();
    }
    if (/^https:\/\//.test(pr.url)) exec("open", [pr.url]);
  }

  selected(id) {
    return this.keyboard && this.sel === id;
  }

  // A new focus request from the shortcut moves the keyboard here.
  takeFocus(cx) {
    const req = shared(INBOX_FOCUS);
    if (!req || req.at === this.focusAt) return;
    this.focusAt = req.at;
    this.returnPane = req.pane;
    // Focus can't move during render, so it moves on the next tick.
    cx.timer.after(30, (cx) => {
      this.h.focus();
      cx.notify();
    });
  }

  navKey(e, cx) {
    const items = this.nav ?? [];
    const at = items.findIndex((i) => i.id === this.sel);
    if (e.key === "down" || e.key === "up") {
      const next = at < 0 ? 0 : Math.min(items.length - 1, Math.max(0, at + (e.key === "down" ? 1 : -1)));
      this.sel = items[next]?.id ?? null;
    } else if (e.key === "enter" && at >= 0) {
      items[at].go();
    } else if (e.key === "escape") {
      this.sel = null;
      if (this.returnPane) run("pane.focus", { pane: this.returnPane });
    } else {
      return;
    }
    cx.stop_propagation();
    cx.notify();
  }
}
