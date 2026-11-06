// Claude Desktop's sessions in the Inbox: what asks you something or waits for your review. Mixed into Inbox.
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { shared, setShared } from "herdr";
import { DESKTOP, openDesktop } from "./desktop.js";
import { contextOfPath, inFocus } from "./context.js";
import { desktopKey, isSettled } from "./lib/desktop.js";
import { ago } from "./lib/time.js";
import { button, sectionHeader } from "./ui.js";

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
    return this.card(t, `dk-${s.id}`, asks,
      this.head(t, asks ? t.blocked : t.done, s.title && s.title !== s.project ? `${s.project} · ${s.title}` : s.project, ago(s.at)),
      v_flex().gap(2).text_size(11).text_color(t.muted)
        .when(Boolean(s.needs || s.detail), (el) => el.child(div().id(`dk-says-${s.id}`).child(s.needs || s.detail))),
      [
        button(t, `dk-open-${s.id}`, "Open in Desktop", () => openDesktop(s.id), { kind: asks ? "solid" : "outline" }),
        settled
          ? button(t, `dk-undo-${s.id}`, "Undo", (cx) => this.settleDesktop(s, false, cx), { tip: "Back to the list" })
          : button(t, `dk-settle-${s.id}`, "✓", (cx) => this.settleDesktop(s, true, cx), {
            tip: "Addressed: hide until the session does something new",
          }),
      ]);
  }

  // Only questions stay open; sessions ready for review fold under one line, since they wait on nobody.
  desktopGroup(t, list, done) {
    if (!list.length && !done.length) return [];
    const asks = list.filter((s) => s.state === "blocked"), review = list.filter((s) => s.state !== "blocked");
    const open = this.expanded["desktop-review"];
    return [
      sectionHeader(t, "IN DESKTOP", asks.length),
      ...asks.map((s) => this.desktopCard(t, s)),
      ...(review.length
        ? [div().id("desktop-review").px(4).py(2).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((s) => s.text_color(t.muted))
          .on_click((_e, cx) => {
            this.expanded["desktop-review"] = !open;
            cx.notify();
          })
          .child(`${open ? "▾" : "▸"} ${review.length} ready for review`)]
        : []),
      ...(open ? review.map((s) => this.desktopCard(t, s)) : []),
      ...this.addressedFold(t, "desktop", done, (s) => this.desktopCard(t, s, true)),
    ];
  }
}
