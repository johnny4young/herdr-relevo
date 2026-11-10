import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { filterShortcutHelpRows, buildShortcutHelpRows } from "./lib/shortcut-help.js";

export class ShortcutHelp {
  init({ actions = [], bindings = {}, onClose = null }, _cx) {
    this.actions = actions;
    this.bindings = bindings;
    this.onClose = onClose;
    this.closed = false;
    this.query = "";
    this.input = InputState.new({ value: "", placeholder: "Search actions, keys, or modifiers…" });
    this.input.on("change", (_event, cx) => {
      if (this.closed) return;
      this.query = this.input.value();
      cx.notify();
    });
  }

  setData(actions, bindings) {
    this.actions = actions;
    this.bindings = bindings;
  }

  focus() {
    if (!this.closed) this.input.focus();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.input.release();
  }

  key(event, cx) {
    if (this.closed || event.key !== "escape") return;
    cx.stop_propagation();
    if (this.query.trim()) {
      this.query = "";
      this.input.set_value("");
      this.input.focus();
      cx.notify();
      return;
    }
    this.onClose?.(cx);
  }

  render(t, cx) {
    const rows = filterShortcutHelpRows(buildShortcutHelpRows(this.actions, this.bindings), this.query);
    const sections = [...new Set(rows.map((row) => row.section))];
    return v_flex().id("shortcut-help").w_full().min_w(0).flex_none()
      .h(Math.min(230, 96 + rows.length * 28 + sections.length * 20)).overflow_y_scrollbar().gap(8).on_key_down((event, cx) => this.key(event, cx))
      .child(Input.new(this.input).id("shortcut-help-search").h(32).px(10).items_center().rounded(6)
        .border(1).border_color(t.accent).bg(t.background).accessibility_label("Search shortcuts"))
      .child(div().id("shortcut-help-hint").text_size(11).text_color(t.dim)
        .child("Search action names, key names, or modifier spellings. Escape clears search, then closes help."))
      .when(!rows.length, (el) => el.child(div().id("shortcut-help-empty").p(8).text_color(t.muted).child("No matching actions")))
      .children(sections.map((section) => v_flex().id(`shortcut-help-section-${section}`).gap(2)
        .child(div().px(2).pt(4).text_size(11).text_color(t.dim).child(section))
        .children(rows.filter((row) => row.section === section).map((row) => h_flex().id(`shortcut-help-${row.id}`)
          .min_h(28).px(4).gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(row.label))
          .child(div().flex_none().text_size(11).text_color(row.assigned ? t.muted : t.dim)
            .child(row.assigned ? row.shortcut : "Unassigned"))))));
  }
}
