import { run, exec, focused, shared, setShared } from "herdr";
import { pickAccount } from "./accounts.js";
import { openReview } from "./review.js";
import { launchSkill } from "./skills.js";
import { showPanel } from "./toolbar.js";
import { recent } from "./lib/github.js";
import { openDesktop } from "./desktop.js";

// A request to focus the Inbox, with the pane to give the keyboard back to on Esc.
export const INBOX_FOCUS = "relevo.inbox.focus";
const SECTIONS = ["away", "waiting", "desktop", "landing", "results", "requested", "mine", "local", "linked", "today", "trees"];

export function focusInbox() {
  showPanel("inbox");
  setShared(INBOX_FOCUS, { at: Date.now(), pane: focused()?.pane ?? null });
}

// ↑/↓ pick a card or row and Enter runs its main action. Mixed into Inbox, so `this` is the Inbox.
export class KeyNav {
  // The selectable items in screen order, each with what Enter does.
  navItems(v) {
    const items = this.awayItems().map((r) => ({ id: r.id, section: "away", go: r.go }));
    for (const i of v.local.filter((x) => x.kind === "blocked")) {
      const drawn = i.prompt;
      items.push({
        id: `in-${i.agent.address}`, section: "waiting", go: () => run("agent.focus", { terminal: i.agent.address }),
        choose: (n, cx) => {
          const option = drawn?.options.find((o) => o.n === n);
          if (option) this.answer(i.agent, option, cx, drawn);
        },
      });
    }
    for (const s of v.desktop.filter((x) => x.state === "blocked" || this.expanded["desktop-review"])) {
      items.push({ id: `dk-${s.id}`, section: "desktop", go: () => openDesktop(s.id) });
    }
    items.push(...this.reviewEntries().map((entry) => ({ id: entry.id, section: "results", go: entry.go })));
    for (const [key, list] of [["requested", v.requested], ["mine", v.mine]]) {
      const shownPRs = [...list.filter(recent), ...(this.expanded[key] ? list.filter((p) => !recent(p)) : [])];
      if (key === "mine" && this.expanded["mine-ready"]) shownPRs.push(...v.ready);
      if (key === "mine" && this.expanded["mine-drafts"]) shownPRs.push(...(this.drafts ?? []));
      if (this.expanded[`${key}-done`]) shownPRs.push(...(key === "mine" ? v.mineDone ?? [] : v.requestedDone ?? []));
      for (const pr of new Map(shownPRs.map((pr) => [pr.url, pr])).values()) items.push({ id: `pr-${pr.url}`, section: key, go: () => pr.isDraft ? exec("open", [pr.url]) : this.runPR(pr) });
    }
    for (const i of [...v.local.filter((x) => x.kind === "diff"), ...(this.expanded["local-done"] ? v.localDone ?? [] : [])]) {
      items.push({ id: `in-${i.agent.address}`, section: "local", go: () => openReview(i.top, i.agent.address) });
    }
    items.push(...this.linkedReviews(v).filter((source) => !source.addressed || this.expanded["linked-done"]).map((source) => ({
      id: `pr-${source.pr.url}`, section: "linked", go: () => source.draft ? exec("open", [source.pr.url]) : this.runPR(source.pr),
    })));
    for (const w of v.worktrees.filter((x) => x.merged && this.inSight(x))) {
      items.push({ id: `wt-${w.path}`, section: "trees", go: () => this.openTree(w) });
    }
    if (this.expanded.loose) {
      for (const w of this.looseRows(v.worktrees)) {
        items.push({ id: `wt-${w.path}`, section: "trees", go: () => this.openTree(w) });
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

  // The list can't be scrolled from code, so while the keyboard moves down it hides what is above
  // the selection, keeping one item for context.
  viewport() {
    const none = { hidden: new Set(), sections: new Set(), above: 0 };
    const items = this.nav ?? [], at = items.findIndex((i) => i.id === this.sel);
    if (!this.keyboard || at < 2) return none;
    const hidden = new Set(items.slice(0, at - 1).map((i) => i.id));
    const mine = SECTIONS.indexOf(items[at].section);
    const sections = new Set(SECTIONS.filter((key, i) => i < mine
      && (key === "today" || items.filter((n) => n.section === key).every((n) => hidden.has(n.id)))));
    return { hidden, sections, above: hidden.size };
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
    // Only while the merge alert is fresh; later the shortcut opens the Inbox as usual.
    if (this.pendingSel && Date.now() - this.pendingSel.at < 10 * 60000) this.sel = this.pendingSel.id;
    this.pendingSel = null;
    // Focus can't move during render, so it moves on the next tick.
    cx.timer.after(30, (cx) => {
      this.h.focus();
      cx.notify();
    });
  }

  navKey(e, cx) {
    // Help search owns keyboard input while open, including Escape when focus
    // has moved to another Inbox control.
    if (this.goalHelp) {
      if (e.key === "escape") this.shortcutHelp?.key(e, cx);
      return;
    }
    // While a reply is typed, the field owns the keys; Esc drops the reply.
    if (this.replying) {
      if (e.key !== "escape") return;
      this.replying = null;
      cx.stop_propagation();
      return cx.notify();
    }
    // A focused button/input owns its keys. Never run a selected card's action
    // as a side effect of activating a descendant control with Enter.
    if (!this.h.is_focused()) return;
    const items = this.nav ?? [];
    const at = items.findIndex((i) => i.id === this.sel);
    const held = e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt;
    if (held) return;
    if (this.goalAction?.(e.key, cx)) {
      // These commands only apply while the queue itself has keyboard focus.
    } else if (e.key === "home" || e.key === "end") {
      this.sel = items[e.key === "home" ? 0 : items.length - 1]?.id ?? null;
    } else if (/^[1-9]$/.test(e.key) && items[at]?.choose) {
      items[at].choose(Number(e.key), cx);
    } else if (e.key === "down" || e.key === "up") {
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
