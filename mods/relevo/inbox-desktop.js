// Claude Desktop's sessions in the Inbox: what asks you something or waits for your review. Mixed into Inbox.
import { div } from "gpui-kit";
import { shared, setShared } from "herdr";
import { DESKTOP, openDesktop } from "./desktop.js";
import { contextOfPath, inFocus } from "./context.js";
import { desktopKey, isSettled } from "./lib/desktop.js";
import { ago } from "./lib/time.js";
import { button, icon } from "./ui.js";

const SETTLED = "relevo.desktop.settled";
const RANK = { blocked: 0, review: 1 };

export class DesktopViews {
  desktopSessions() {
    return (shared(DESKTOP) ?? []).filter((s) => s.state !== "working" && inFocus(contextOfPath(s.cwd)))
      .sort((a, b) => RANK[a.state] - RANK[b.state] || b.at - a.at);
  }

  // The agents list leaves settled sessions out too.
  publishSettled() {
    const ids = (shared(DESKTOP) ?? []).filter((s) => isSettled(s, this.addressed)).map((s) => s.id);
    if (JSON.stringify(shared(SETTLED) ?? []) !== JSON.stringify(ids)) setShared(SETTLED, ids);
  }

  settleDesktop(s, on, cx) {
    const next = { ...this.addressed };
    if (on) next[desktopKey(s)] = Math.ceil(Date.now() / 1000);
    else delete next[desktopKey(s)];
    this.saveAddressed(next);
    this.publish();
    cx.notify();
  }

  desktopCard(t, s, settled = false) {
    const asks = s.state === "blocked";
    return this.item(t, `dk-${s.id}`, {
      turn: asks ? "me" : "ready", kind: "desktop", title: s.project, reason: s.needs || s.detail || (asks ? "asks you" : "ready for review"),
      tip: s.title && s.title !== s.project ? s.title : null, age: ago(s.at, true),
      lines: [s.title && s.title !== s.project ? div().id(`dk-says-${s.id}`).truncate().text_size(11).text_color(t.muted).child(s.title) : null],
      main: button(t, `dk-open-${s.id}`, "Open in Desktop", () => openDesktop(s.id), { kind: asks ? "go" : "outline" }),
      mark: settled
        ? button(t, `dk-undo-${s.id}`, "Undo", (cx) => this.settleDesktop(s, false, cx), { tip: "Back to the list" })
        : button(t, `dk-settle-${s.id}`, [icon("check")], (cx) => this.settleDesktop(s, true, cx), {
          tip: "Addressed: hide until the session does something new",
        }),
    });
  }
}
