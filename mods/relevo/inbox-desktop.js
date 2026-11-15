// Claude Desktop's sessions in the Inbox: what asks you something or waits for your review. Mixed into Inbox.
import { div } from "gpui-kit";
import { shared, setShared } from "herdr";
import { DESKTOP, openDesktop } from "./desktop.js";
import { contextOfPath, inFocus } from "./context.js";
import { desktopKey, isSettled } from "./lib/desktop.js";
import { ago } from "./lib/time.js";

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

  // What a Desktop row can do, for its buttons, its keys and its keycaps alike.
  desktopActions(s, settled = false) {
    return {
      main: { id: `dk-open-${s.id}`, key: "o", label: "Open in Claude Desktop", run: () => openDesktop(s.id), kind: s.state === "blocked" ? "go" : "outline" },
      mark: this.markAction(s.id, settled, (on, cx) => this.settleDesktop(s, on, cx), "Addressed: hide until the session does something new",
        { on: "dk-settle", off: "dk-undo" }),
    };
  }

  desktopCard(t, s, settled = false) {
    const asks = s.state === "blocked", named = s.title && s.title !== s.project ? s.title : null;
    return this.item(t, `dk-${s.id}`, {
      turn: asks ? "me" : "ready", done: settled, kind: "desktop", title: s.project, reason: s.needs || s.detail || (asks ? "asks you" : "ready for review"),
      tip: named, age: ago(s.at, true),
      lines: [named ? div().id(`dk-says-${s.id}`).truncate().text_size(11).text_color(t.muted).child(named) : null,
        s.said ? div().id(`dk-said-${s.id}`).text_size(11).text_color(t.foreground).child(s.said.length > 320 ? `${s.said.slice(0, 319)}…` : s.said) : null],
      ...this.desktopActions(s, settled),
    });
  }
}
