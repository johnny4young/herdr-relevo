import { run, exec, focused, shared, setShared, theme } from "herdr";
import { NOW_SECTIONS } from "./inbox-now.js";
import { GOAL_MODE } from "./inbox-goals.js";
import { pickAccount } from "./accounts.js";
import { launchSkill } from "./skills.js";
import { showPanel } from "./toolbar.js";

// A request to focus the Inbox, with the pane to give the keyboard back to on Esc.
export const INBOX_FOCUS = "relevo.inbox.focus";

// `row` asks for that row to be selected once the Inbox has the keyboard.
export function focusInbox(row = null) {
  showPanel("inbox");
  setShared(INBOX_FOCUS, { at: Date.now(), pane: focused()?.pane ?? null, row });
}

// ↑/↓ pick a card or row and Enter runs its main action. Mixed into Inbox, so `this` is the Inbox.
export class KeyNav {
  // The selectable rows of the view on screen, in screen order, each with what Enter and the number keys do.
  navItems(v) {
    return this.reviewView() === "now" ? this.nowNav(this.nowEntries(theme(), v)) : this.maintenanceNav(v);
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
    const held = e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt;
    if (held) return;
    this.clicked = false;
    // Runs also move with j and k.
    const runs = shared(GOAL_MODE) === true, key = runs && e.key === "j" ? "down" : runs && e.key === "k" ? "up" : e.key;
    if (runs && this.runKey?.(e, cx)) {
      // The open run or task took the key.
    } else if (this.goalAction?.(e.key, cx)) {
      // These commands only apply while the queue itself has keyboard focus.
    } else if (shared(GOAL_MODE) !== true && this.reviewView() === "maintenance" && this.maintenanceKey(e, cx)) {
      // x, X, d and Esc on the selection; s, o and d on the selected worktree.
    } else if (e.key === "home" || e.key === "end") {
      this.sel = items[e.key === "home" ? 0 : items.length - 1]?.id ?? null;
    } else if ((e.key === "m" || e.key === "n") && shared(GOAL_MODE) !== true) {
      this.setReviewView(e.key === "m" ? "maintenance" : "now", cx);
    } else if (/^[1-9]$/.test(e.key) && items[at]?.choose) {
      items[at].choose(Number(e.key), cx);
    } else if (key === "down" || key === "up") {
      const next = at < 0 ? 0 : Math.min(items.length - 1, Math.max(0, at + (key === "down" ? 1 : -1)));
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
