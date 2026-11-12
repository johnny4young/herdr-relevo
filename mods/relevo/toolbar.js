import { div, svg } from "gpui-kit";
import { h_flex, Button } from "gpui-base";
import { theme, run, layout, shared, setShared } from "herdr";
import { withKey } from "./ui.js";

export const COUNT = "relevo.inbox.count";
// The count when the Inbox was last open: a higher one pulses the badge.
const SEEN_COUNT = "relevo.inbox.seen";
const GOAL_MODE = "relevo.goals.mode";

const find = (node, id) => {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
};

export function showPanel(child) {
  run("layout.select", { stack: "panel-body", child });
  run("layout.show", { id: "panel" });
}

export class InboxButton {
  init(props) { this.preview = props?.syntheticPreview === true; }

  render() {
    const t = theme();
    if (this.preview) return h_flex().size_full().items_center().justify_center().bg(t.chrome)
      .child(Button.new("preview-queue").id("preview-queue").h(28).px(8).rounded(6).text_size(13)
        .text_color(t.foreground).tab_index(0).accessibility_label("Preview queue")
        .tooltip("Open the isolated preview queue")
        .on_click(() => showPanel("inbox")).child("Preview"));
    const panel = find(layout(), "panel"), body = find(layout(), "panel-body");
    const on = panel && !panel.hidden && body?.active === "inbox";
    const runs = shared(GOAL_MODE) === true, reviewsOn = on && !runs;
    const bar = find(layout(), "panel-bar"), hideBar = body?.active === "inbox";
    // The file controls belong to Files/Changes, not the work queues. This
    // always-mounted navigation also restores them after another panel opens.
    if (bar && Boolean(bar.hidden) !== hideBar) run(hideBar ? "layout.hide" : "layout.show", { id: "panel-bar" });
    const n = shared(COUNT) ?? 0, stored = shared(SEEN_COUNT), seen = stored ?? n;
    if (stored == null || (reviewsOn ? seen !== n : n < seen)) setShared(SEEN_COUNT, n);
    const fresh = !reviewsOn && n > seen;
    const tab = (id, label, isRuns) => {
      const active = on && runs === isRuns;
      return Button.new(id).id(id).h(28).px(8).gap(5).flex().items_center().rounded(6)
        .tab_index(0).accessibility_label(label).text_size(13)
        .text_color(active ? t.foreground : t.muted).when(active, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover)).focus((s) => s.border_2().border_color(t.accent))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .tooltip(isRuns ? "Launch prompts and follow their results" : withKey("Review changes and decisions", "relevo.panel-inbox"))
        .on_click(() => { setShared(GOAL_MODE, isRuns); showPanel("inbox"); })
        .child(label)
        .when(!isRuns && n > 0, (el) => el.child(div().px(5).rounded(8).bg(t.blocked)
          .text_color(t.background).text_size(11).font_semibold()
          .when(fresh, (b) => b.loop("opacity", { from: 0.45, to: 1, period: 1400 }))
          .child(String(n))));
    };
    return h_flex().id("inbox-button").size_full().items_center().justify_center()
      .bg(t.chrome).border_b(1).border_color(t.border)
      .gap(3).child(tab("reviews-toggle", "Reviews", false)).child(tab("runs-toggle", "Runs", true));
  }
}

// Mirrors the left sidebar's toggle at the window's other edge.
export class PanelToggle {
  render() {
    const t = theme(), panel = find(layout(), "panel"), on = Boolean(panel && !panel.hidden);
    return h_flex().id("panel-toggle-bar").size_full().items_center().justify_center()
      .bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().id("panel-toggle").size(26).flex().items_center().justify_center().rounded(6).cursor_pointer()
        .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(withKey(on ? "Hide panel" : "Show panel", "layout.toggle:panel"))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => run("layout.toggle", { id: "panel" }))
        .child(svg("mods/relevo/panel.svg").size(15)));
  }
}
