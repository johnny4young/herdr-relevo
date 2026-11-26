import { run, focused, shared, setShared, theme } from "herdr";
import { NOW_SECTIONS } from "./inbox-now.js";
import { GOAL_MODE } from "./inbox-goals.js";
import { pickAccount } from "./accounts.js";
import { launchSkill } from "./skills.js";
import { showPanel } from "./toolbar.js";
import { openGoal } from "./goals-editor.js";
import { openUrl } from "./ui.js";

// A request to focus the Inbox, with the pane to give the keyboard back to on Esc.
export const INBOX_FOCUS = "relevo.inbox.focus";

// `row` asks for that row to be selected once the Inbox has the keyboard.
export function focusInbox(row = null, filter = null) {
  showPanel("inbox");
  setShared(INBOX_FOCUS, { at: Date.now(), pane: focused()?.pane ?? null, row, filter });
}

// ↑/↓ pick a card or row and Enter runs its main action. Mixed into Inbox, so `this` is the Inbox.
export class KeyNav {
  // The selectable rows of the view on screen, in screen order, each with what Enter and the number keys do.
  navItems(v) {
    return this.reviewView() === "now" ? this.nowNav(this.filterNow(this.nowEntries(theme(), v))) : this.maintenanceNav(v);
  }

  // Its agent if one runs, else the suggested skill when the repo is cloned, else the PR on GitHub.
  runPR(pr) {
    const agent = this.prAgents[pr.url], folder = this.clones[pr.repo];
    if (agent) return run("agent.focus", { terminal: agent.address });
    if (folder && pr.skills?.length) {
      launchSkill(pr, pr.skills[0], pickAccount(pr.repo, this.quotas).key, folder);
      return this.publish();
    }
    openUrl(pr.url);
  }

  // The list can't be scrolled from code, so while the keyboard moves down it hides what is above
  // the selection, keeping one item for context. A click never moves the list under the pointer.
  viewport(sections = NOW_SECTIONS) {
    const none = { hidden: new Set(), sections: new Set(), above: 0 };
    const items = this.nav ?? [], at = items.findIndex((i) => i.id === this.sel);
    if (!this.keyboard || this.clicked || at < 2) return none;
    const hidden = new Set(items.slice(0, at - 1).map((i) => i.id));
    const mine = sections.indexOf(items[at].section);
    const above = new Set(sections.filter((key, i) => i < mine
      && (key === "today" || items.filter((n) => n.section === key).every((n) => hidden.has(n.id)))));
    return { hidden, sections: above, above: hidden.size };
  }

  // A selected row stays open until Esc or another selection, with or without the keyboard here.
  selected(id) {
    return this.sel === id;
  }

  // A new focus request from the shortcut moves the keyboard here.
  takeFocus(cx) {
    const req = shared(INBOX_FOCUS);
    if (!req || req.at === this.focusAt) return;
    this.focusAt = req.at;
    this.returnPane = req.pane;
    if (typeof req.filter === "string") this.filterField?.set_value(req.filter);
    // Only while the merge alert is fresh; later the shortcut opens the Inbox as usual.
    if (req.row) this.reveal(req.row);
    else if (this.pendingSel && Date.now() - this.pendingSel.at < 10 * 60000) this.reveal(this.pendingSel.id);
    this.pendingSel = null;
    // Focus can't move during render, so it moves on the next tick.
    cx.timer.after(30, (cx) => {
      this.h.focus();
      cx.notify();
    });
  }

  // The filter field opens under the header; what it holds narrows Now to the rows whose words contain it.
  openFilter(cx) {
    this.filtering = true;
    this.filterField.focus();
    cx.notify();
  }

  // Esc clears the filter, Enter keeps it; either way the list takes the keyboard back.
  leaveFilter(cx, { clear = false } = {}) {
    this.filtering = false;
    if (clear) this.filterField.set_value("");
    this.h.focus();
    cx.notify();
  }

  navKey(e, cx) {
    // Help search owns keyboard input while open, including Escape when focus
    // has moved to another Inbox control.
    if (this.goalHelp) {
      if (e.key === "escape") this.shortcutHelp?.key(e, cx);
      return;
    }
    if (this.actionMenu) {
      this.actionMenuKey?.(e, cx);
      return;
    }
    // While the filter is typed, the field owns the keys; Esc clears and closes it.
    if (this.filtering) {
      if (e.key !== "escape") return;
      cx.stop_propagation();
      return this.leaveFilter(cx, { clear: true });
    }
    // While a reply is typed, the field owns the keys; Esc drops the reply.
    if (this.replying) {
      if (e.key !== "escape") return;
      this.replying = null;
      cx.stop_propagation();
      return cx.notify();
    }
    // The change request owns the keys while it is typed; Esc drops it.
    if (this.runChangeFor && shared(GOAL_MODE) === true) {
      if (e.key !== "escape") return;
      this.cancelRunChanges();
      cx.stop_propagation();
      return cx.notify();
    }
    // A focused button/input owns its keys. Never run a selected card's action
    // as a side effect of activating a descendant control with Enter.
    if (!this.h.is_focused()) return;
    const items = this.nav ?? [];
    const at = items.findIndex((i) => i.id === this.sel);
    const reviews = shared(GOAL_MODE) !== true;
    const cmdK = e.modifiers?.platform && !e.modifiers?.alt && !e.modifiers?.control && e.key === "k";
    if (cmdK && reviews && at >= 0 && items[at]?.allActions) {
      this.openActionMenu?.(items[at], cx);
      cx.stop_propagation();
      return;
    }
    const held = e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt;
    if (held) return;
    this.clicked = false;
    const shifted = e.key === "g" && e.modifiers?.shift;
    const key = e.key === "j" ? "down" : e.key === "k" ? "up" : shifted ? "G" : e.key;
    // g then g goes to the top, as in vim, and any other key in between starts over; G goes to the bottom.
    const gg = key === "g" && reviews && this.pendingG;
    this.pendingG = key === "g" && reviews && !gg;
    if (this.pendingG) return cx.stop_propagation();
    const rowKey = reviews && at >= 0 ? items[at].keys?.()[key] : null;
    if (rowKey) {
      // A held key repeats; l arms on the first press, so a repeat must not confirm the merge.
      if (!e.is_held) rowKey(cx);
    } else if (gg || (key === "G" && reviews)) {
      this.sel = items[gg ? 0 : items.length - 1]?.id ?? null;
    } else if (key === "u" && reviews && this.lastMark) {
      this.lastMark(cx);
      this.lastMark = null;
    } else if (key === "/" && reviews && this.reviewView() === "now") {
      this.openFilter(cx);
    } else if (!reviews && this.runKey?.(e, cx)) {
      // The open run or task took the key.
    } else if (this.goalAction?.(key, cx)) {
      // These commands only apply while the queue itself has keyboard focus.
    } else if (reviews && this.reviewView() === "maintenance" && this.maintenanceKey(e, cx)) {
      // x, X, d and Esc on the selection; s, o and d on the selected worktree.
    } else if (key === "home" || key === "end") {
      this.sel = items[key === "home" ? 0 : items.length - 1]?.id ?? null;
    } else if (key === "n" && reviews) {
      openGoal();
    } else if (key === "h" && reviews && this.reviewView() === "now" && at >= 0 && items[at]?.snooze) {
      this.openActionMenu?.(items[at], cx, { mode: "snooze" });
    } else if ((key === "tab" || key === "m") && reviews) {
      this.setReviewView(this.reviewView() === "maintenance" ? "now" : "maintenance", cx);
    } else if (/^[1-9]$/.test(key) && items[at]?.choose) {
      items[at].choose(Number(key), cx);
    } else if (key === "down" || key === "up") {
      const next = at < 0 ? 0 : Math.min(items.length - 1, Math.max(0, at + (key === "down" ? 1 : -1)));
      this.sel = items[next]?.id ?? null;
    } else if (key === "enter" && at >= 0) {
      // Enter may arm a land, so a repeat must not confirm it either.
      if (!e.is_held) items[at].go(cx);
    } else if (key === "escape") {
      this.sel = null;
      if (this.returnPane) run("pane.focus", { pane: this.returnPane });
    } else {
      return;
    }
    cx.stop_propagation();
    cx.notify();
  }
}
