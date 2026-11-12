import { div, svg } from "gpui-kit";
import { h_flex, Button } from "gpui-base";
import { appHome, readTextFile, shared, setShared } from "herdr";
import { relevoKeys, formatShortcut } from "./lib/keys.js";

const SIZES = {
  sm: { h: 24, px: 7, text: 11, radius: 5 },
  md: { h: 28, px: 9, text: 13, radius: 6 },
  lg: { h: 32, px: 12, text: 13, radius: 6 },
};

export function overlayHeight(preferred, fraction = 0.85) {
  if (!Number.isFinite(preferred) || preferred <= 0 || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) return preferred;
  try {
    const height = globalThis.window?.viewport_size?.().height;
    if (!Number.isFinite(height) || height <= 0) return preferred;
    return Math.min(preferred, height * fraction);
  } catch {
    return preferred;
  }
}

// kind: "outline" (default), "solid", "ghost" (no frame until hovered or selected) or "danger". A disabled button keeps its place and ignores clicks.
export function button(t, id, label, onClick, { kind = "outline", size = "md", tip = null, disabled = false, selected = false, accessibleLabel = null } = {}) {
  const s = SIZES[size];
  const quiet = size === "sm" ? t.muted : t.foreground;
  return Button.new(id).id(id).h(s.h).px(s.px).flex_none().flex().items_center().gap(5).rounded(s.radius).text_size(s.text)
    .disabled(disabled).selected(selected).tab_index(0).tab_stop(!disabled)
    .accessibility_label(accessibleLabel ?? (typeof label === "string" ? (tip ? `${label}. ${tip}` : label) : tip ?? id))
    .focus((el) => el.border_2().border_color(t.accent))
    .when(disabled, (el) => el.bg(t.raised).text_color(t.dim))
    .when(!disabled && kind === "solid", (el) => el.bg(t.solid).text_color(t.solid_foreground).cursor_pointer())
    .when(!disabled && kind === "outline", (el) => el.border_1().border_color(t.border).text_color(quiet).cursor_pointer()
      .hover((st) => st.bg(t.hover).text_color(t.foreground)))
    .when(!disabled && kind === "outline" && selected, (el) => el.bg(t.selected).border_color(t.accent).text_color(t.foreground))
    .when(!disabled && kind === "ghost", (el) => el.text_color(selected ? t.foreground : quiet).cursor_pointer()
      .when(selected, (g) => g.bg(t.selected)).hover((st) => st.bg(t.hover).text_color(t.foreground)))
    .when(!disabled && kind === "danger", (el) => el.border_1().border_color(t.blocked).text_color(t.blocked).cursor_pointer()
      .hover((st) => st.bg(t.hover)))
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .when(!disabled, (el) => el.on_click((_e, cx) => {
      cx.stop_propagation();
      onClick(cx);
    }))
    .children(Array.isArray(label) ? label : [label]);
}

// A small status label; tone colors the text, the surface stays neutral.
export const pill = (t, id, label, tone = t.muted) =>
  div().id(id).h(20).px(8).flex().flex_none().items_center().rounded(10).bg(t.raised).text_size(11).text_color(tone).child(label);

// Tabs read as text with an underline on the open one, not as a row of buttons.
export const tabButton = (t, id, label, selected, onClick, tip = null) =>
  button(t, id, label, onClick, { kind: "ghost", size: "sm", tip })
    .rounded(0).border_b(2).border_color(selected ? t.accent : t.background).text_color(selected ? t.foreground : t.muted)
    .when(selected, (el) => el.bg(t.background));

// A list section's title with its count or total on the right.
export const sectionHeader = (t, label, right) =>
  h_flex().pt(6).px(2).justify_between().text_size(11).text_color(t.dim).child(label).child(String(right));

// Shortcuts come from keys.json, so a tooltip never shows a key that changed.
let keys = {};

export async function loadKeys() {
  try {
    keys = relevoKeys(JSON.parse(await readTextFile(`${appHome()}/keys.json`) ?? "{}"));
  } catch {
    keys = {};
  }
}

export const shortcut = (action) => formatShortcut(keys[action]);

// Searchable help uses the same merged map as badges and tooltips.
export const shortcutBindings = () => ({ ...keys });

export const withKey = (tip, action) => (shortcut(action) ? `${tip} · ${shortcut(action)}` : tip);

// Native rotation: no timer, no redraws.
export const spinner = (color, size = 11) => svg("mods/relevo/spinner.svg").size(size).text_color(color).spin(900);

// Which folds are open, kept across reloads; a card's "more" lines are not kept.
export const FOLDS = "relevo.inbox.folds";
export function saveFolds(expanded) {
  const kept = Object.fromEntries(Object.entries(expanded).filter(([k, v]) => v && !k.startsWith("more-")));
  if (JSON.stringify(kept) !== JSON.stringify(shared(FOLDS) ?? {})) setShared(FOLDS, kept);
}

// A "▸ N things" line that folds a list open or shut; `key` names its state in view.expanded.
export function foldRow(view, t, id, key, label, { gap = false, onOpen = null, after = null } = {}) {
  const open = Boolean(view.expanded[key]);
  return Button.new(id).id(id).tab_index(0).selected(open).accessibility_label(`${label}. ${open ? "Collapse" : "Expand"}`)
    .tooltip(`${open ? "Collapse" : "Expand"} ${label}`).focus((el) => el.border_2().border_color(t.accent))
    .min_h(28).px(4).when(gap, (el) => el.pt(6)).when(!gap, (el) => el.py(2))
    .flex().items_center().gap(5).text_size(11).text_color(t.dim).cursor_pointer()
    .hover((s) => s.text_color(t.muted))
    .on_click((_e, cx) => {
      cx.stop_propagation();
      view.expanded[key] = !open;
      saveFolds(view.expanded);
      if (!open) onOpen?.(cx);
      cx.notify();
    })
    .child(`${open ? "▾" : "▸"} ${label}`)
    .when(Boolean(after), (el) => el.child(after));
}

// A text field keeps ⌘Enter from the window: a textarea inserts the line break, then emits submit.
export function onSubmitChord(state, run) {
  state.on("submit", (event, cx) => {
    if (!event?.secondary) return;
    const value = state.value();
    if (value.endsWith("\n")) state.set_value(value.slice(0, -1));
    run(cx);
  });
}
