import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Button } from "gpui-base";
import { appHome, exec, readTextFile, settings, shared, setShared, window } from "herdr";
import { relevoKeys, formatShortcut } from "./lib/keys.js";
import { QUOTA_WARN } from "./lib/account-status.js";

// Opens only HTTPS links so untrusted PR/run data cannot invoke local schemes or open(1) flags.
export function openUrl(url) {
  if (typeof url === "string" && /^https:\/\/\S+$/i.test(url)) exec("open", [url]);
}

// The window can't be seen: minimized, on another Space, fully covered or on a sleeping display.
export const unseen = () => window()?.visible === false;

// A timer's work while the window can't be seen: work that only paints waits (`slower` 0), and work that feeds
// alerts runs on every `slower`-th tick.
export function paced(fn, slower = 0) {
  let skipped = 0;
  return (cx) => {
    if (unseen() && (!slower || ++skipped < slower)) return;
    skipped = 0;
    fn(cx);
  };
}

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

const FILLED = { go: "blocked", accent: "accent" };
// The words of a label, with its tip; a label of icons alone is read as its tip.
function spoken(label, tip, id) {
  const words = (Array.isArray(label) ? label : [label]).filter((part) => typeof part === "string").join(" ");
  return words ? (tip ? `${words}. ${tip}` : words) : tip ?? id;
}

// kind: "outline" (default), "solid", "go" (the one action of a row that waits on you), "accent", "ghost" (no frame until hovered or selected) or "danger". A disabled button keeps its place and ignores clicks.
export function button(t, id, label, onClick, { kind = "outline", size = "md", tip = null, disabled = false, selected = false, accessibleLabel = null } = {}) {
  const s = SIZES[size];
  const quiet = size === "sm" ? t.muted : t.foreground;
  return Button.new(id).id(id).h(s.h).px(s.px).flex_none().flex().items_center().gap(5).rounded(s.radius).text_size(s.text)
    .disabled(disabled).selected(selected).tab_index(0).tab_stop(!disabled)
    .accessibility_label(accessibleLabel ?? spoken(label, tip, id))
    .focus((el) => el.border_2().border_color(t.accent))
    .when(disabled, (el) => el.bg(t.raised).text_color(t.dim))
    .when(!disabled && kind === "solid", (el) => el.bg(t.solid).text_color(t.solid_foreground).cursor_pointer())
    .when(!disabled && Boolean(FILLED[kind]), (el) => el.bg(t[FILLED[kind]]).text_color(t.solid_foreground).font_semibold().cursor_pointer())
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
// An error as one line: its first line, cut to fit, with the whole text on hover.
export const firstLine = (text, max = 160) => { const one = String(text ?? "").trim().split("\n")[0]; return one.length > max ? `${one.slice(0, max - 1)}…` : one; };
export const alertLine = (t, id, message) => div().id(id).role("alert").w_full().min_w(0).truncate().text_color(t.blocked).tooltip(String(message)).child(firstLine(message));

export const pill = (t, id, label, tone = t.muted) =>
  div().id(id).h(20).px(8).flex().flex_none().items_center().rounded(10).bg(t.raised).text_size(11).text_color(tone).child(label);

// Tabs read as text with an underline on the open one, not as a row of buttons.
export const tabButton = (t, id, label, selected, onClick, tip = null) =>
  button(t, id, label, onClick, { kind: "ghost", size: "sm", tip })
    .rounded(0).border_b(2).border_color(selected ? t.accent : t.background).text_color(selected ? t.foreground : t.muted)
    .when(selected, (el) => el.bg(t.background));

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
export const spinner = (color, size = 11) => svg("mods/relevo/spinner.svg").size(size).flex_none().text_color(color).spin(900);

// A glyph from icons/ on a 12 px grid; with no colour it takes the text colour, so it follows button states.
export const ICONS = ["agent", "ask", "check", "chevron-down", "chevron-right", "clock", "comment", "desktop", "down", "enter", "file",
  "folder", "gear", "handoff", "land", "more", "note", "pr", "refresh", "relay", "relevo", "review", "run", "search", "server", "tree", "up", "warn", "x"];
export const icon = (name, color = null, size = 12) => svg(`mods/relevo/icons/${name}.svg`).size(size).flex_none()
  .when(Boolean(color), (el) => el.text_color(color));
export const chevron = (open, color = null, size = 12) => icon(open ? "chevron-down" : "chevron-right", color, size);

// A quota's colour: accent, ansi3 from half, blocked from QUOTA_WARN.
export const quotaTone = (t, pct) => (pct >= QUOTA_WARN ? t.blocked : pct >= 50 ? t.ansi3 : t.accent);
// What a check, a leg of a run or a step is doing, as a colour; anything else is not started.
const STATE = { ok: "done", bad: "blocked", run: "working", cancel: "ansi3", you: "blocked", acc: "accent" };
const stateTone = (t, state, idle) => (STATE[state] ? t[STATE[state]] : idle);

// The lane: a 24 px column whose glyph says whose turn it is.
export const LANE = 24;
export function laneGlyph(t, turn) {
  if (turn === "flight") return spinner(t.working, 12);
  if (turn === "ready") return icon("check", t.done, 13);
  if (turn === "stuck") return icon("warn", t.blocked, 12);
  if (turn === "old") return div().size(6).flex_none().rounded_full().bg(t.idle).opacity(0.6);
  if (turn === "me") return div().size(8).flex_none().rounded_full().bg(t.blocked);
  return div().size(8).flex_none().rounded_full().border_1().border_color(t.accent);
}
const lane = (t, turn) => h_flex().w(LANE).flex_none().justify_center().child(laneGlyph(t, turn));

export const TURN_LABEL = { me: "Needs me", flight: "In flight", ready: "Ready", open: "Open", old: "Old", stuck: "Stuck" };
// A tint for what must be acted on now, such as an account near its limit. Rows carry it in their glyph and words.
export const meTint = (t) => `${t.blocked}12`;

// lane · body (kind, what, why) · edge (age, the one action). `lines` always show under the title;
// `below` holds the selected row's extra lines. Narrow, the title gives way before the reason.
export function row(t, id, { turn = "open", kind = null, title, reason = null, sub = null, lines = null, age = null, action = null,
  selected = false, onSelect = null, below = null, tip = null, narrow = false, machine = null } = {}) {
  const hot = turn === "me" || turn === "stuck";
  // Another machine's row wears that machine's Spaces color as a dot before its title.
  const where = machine ? `${machine.name}${machine.away ? " (offline)" : ""}` : null;
  return v_flex().id(id).flex_none().rounded(6).border_1().border_color(selected ? t.accent : `${t.accent}00`)
    .when(selected, (el) => el.bg(t.selected))
    .when(Boolean(onSelect), (el) => el.cursor_pointer().on_click((_e, cx) => onSelect(cx)))
    .when(Boolean(tip || where), (el) => el.tooltip([where, tip].filter(Boolean).join(" · ")))
    .child(h_flex().min_h(38).py(4).pr(8).gap(8).items_center()
      .child(lane(t, turn))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(7).items_center().min_w(0)
          .when(Boolean(kind), (el) => el.child(icon(kind, hot ? t.blocked : t.muted)))
          .when(Boolean(machine), (el) => el.child(div().id(`${id}-machine`).size(7).flex_none().rounded_full().bg(machine.color).accessibility_label(where)))
          .child(div().min_w(narrow ? 48 : 0).truncate().font_semibold().text_size(13).child(title))
          .when(Boolean(reason), (el) => el.child(div().min_w(0).truncate().text_size(13)
            .when(narrow, (r) => r.max_w(100)).when(!narrow, (r) => r.flex_1())
            .text_color(hot ? t.blocked : t.muted).child(reason))))
        .when(Boolean(sub), (el) => el.child(h_flex().pl(19).gap(7).items_center().min_w(0).text_size(11).text_color(t.muted).child(sub)))
        .when(Boolean(lines), (el) => el.children(lines)))
      .when(age != null, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(age)))
      .when(Boolean(action), (el) => el.child(action)))
    .when(Boolean(below), (el) => el.child(v_flex().pl(LANE + 19).pr(8).pb(8).gap(5).children(below)));
}

// Rows are separated by a hairline that starts at the body, past the lane; an inset of 0 runs edge to edge.
export const hairline = (t, inset = LANE) => div().h(1).ml(inset).mr(inset ? 8 : 0).flex_none().bg(t.border).opacity(0.55);
export const joined = (t, rows) => rows.filter(Boolean).flatMap((el, i) => (i ? [hairline(t), el] : [el]));

// A row action as data, so its button, its key and its keycap come from one table; `el` is a control drawn elsewhere.
export function actionButton(t, a) {
  if (a.el) return typeof a.el === "function" ? a.el() : a.el;
  const { kind, size, tip, disabled, accessibleLabel } = a;
  return button(t, a.id, a.label, a.run, { kind, size, tip, disabled, accessibleLabel });
}

// The keys a row answers, from the same table its buttons come from.
export const keysOf = ({ main = null, actions = [], mark = null }) =>
  Object.fromEntries([main, ...actions, mark].filter((a) => a?.key).map((a) => [a.key, a.run]));

// A section label in caps with its count and a hairline to the edge; `after` sits past the hairline.
export const legHeader = (t, id, label, count, { me = false, after = [] } = {}) => h_flex().id(id).h(28).pt(6).pl(LANE).pr(8).gap(8).items_center()
  .text_size(11).text_color(me ? t.blocked : t.dim)
  .child(div().flex_none().child(label.toUpperCase()))
  .child(div().flex_none().font_semibold().text_color(t.foreground).child(String(count)))
  .child(div().flex_1().h(1).bg(t.border).opacity(0.55))
  .children(after.filter(Boolean));

// The counters are the legend: glyph, plain label, count. Narrow, the label moves to the tooltip; `dots` sets short labels apart.
export const legend = (t, id, counts, { narrow = false, dots = false } = {}) => h_flex().id(id).h(36).flex_none().pl(16).pr(8).gap(dots ? 6 : 14).items_center()
  .children(counts.flatMap(({ turn, label = TURN_LABEL[turn], n }, i) => {
    const hot = (turn === "me" || turn === "stuck") && n > 0;
    const el = h_flex().id(`${id}-${turn}`).flex_none().gap(6).items_center().when(narrow, (e) => e.tooltip(label))
      .child(turn === "flight" && !n ? div().size(12).flex_none().rounded_full().border_1().border_color(t.dim) : laneGlyph(t, turn))
      .when(!narrow, (e) => e.child(div().text_size(13).text_color(hot ? t.blocked : t.muted).child(label)))
      .child(div().text_size(13).font_semibold().text_color(hot ? t.blocked : t.foreground).child(String(n)));
    return dots && i ? [div().flex_none().text_size(13).text_color(t.dim).child("·"), el] : [el];
  }));

const monoFont = () => settings().font_family ?? "JetBrains Mono";
export function keycap(t, label, { tone = null, font = monoFont() } = {}) {
  const ink = tone ?? t.muted;
  return div().min_w(17).h(17).px(4).flex().flex_none().items_center().justify_center()
    .rounded(4).border_1().border_b(2).border_color(tone ?? t.border).bg(t.background).text_size(11).text_color(ink)
    .font_family(font).child(label === "enter" ? icon("enter", ink, 10) : label);
}

// The keys that work in this list, at its foot; `right`, like each key, is [caps, label] and sits at the far edge.
export function keyBar(t, id, keys, right = null) {
  const font = monoFont();
  const group = ([caps, label]) => h_flex().gap(4).items_center().flex_none()
    .children(caps.map((c) => keycap(t, c, { font }))).child(div().child(label));
  const away = ([caps]) => caps[0] === "esc" || caps[0] === "tab", back = keys.filter(away), acts = keys.filter((k) => !away(k));
  // A narrow panel wraps whole keys onto a hidden second line; the ways out (esc, tab) and the far edge always stay.
  return h_flex().id(id).h(32).flex_none().pl(16).pr(8).gap(10).items_center()
    .border_t(1).border_color(t.border).bg(t.background).text_size(11).text_color(t.muted)
    .child(h_flex().flex_1().min_w(0).h(20).flex_wrap().gap(10).items_center().overflow_hidden().children(acts.map(group)))
    .children(back.map(group))
    .when(Boolean(right), (el) => el.child(group(right)));
}

// A small label: tone colours the text over a 15% wash of itself.
export const tag = (t, label, tone = t.accent) => div().h(16).px(5).flex().flex_none().items_center().rounded(4)
  .bg(`${tone}26`).text_size(11).text_color(tone).child(label);

export const checkbox = (t, on) => div().size(14).flex().flex_none().items_center().justify_center().rounded(3).border_1()
  .border_color(on ? t.accent : t.dim).when(on, (el) => el.bg(t.accent).child(icon("check", t.solid_foreground, 10)));

// One box per check, in run order: ok, bad, run, or not yet.
export const seg = (t, states) => h_flex().gap(2).flex_none().children(states.map((s) => div().w(9).h(4).rounded(1).bg(stateTone(t, s, t.raised))));

// Five squares split by added and removed lines, in the diff's colours.
const FIVE = [0, 1, 2, 3, 4];
export function diffRatio(t, add, del) {
  const total = add + del, adds = total ? Math.round((add / total) * 5) : 0;
  return h_flex().gap(1).flex_none().children(FIVE.map((i) => div().size(5).rounded(1)
    .bg(!total ? t.raised : i < adds ? t.ansi2 : t.ansi1)));
}

// Age as five ticks at 1m, 5m, 15m, 1h and 1d.
const TICKS = [60e3, 300e3, 900e3, 3600e3, 86400e3];
export const ageTicks = (t, ms, me = false) => h_flex().gap(2).items_end().h(9).flex_none()
  .children(TICKS.map((at) => div().w(2).rounded(1).h(ms >= at ? 9 : 5).bg(ms >= at ? (me ? t.blocked : t.dim) : t.border)));

// Who did what, in order: [{ label, state }]. Bare legs drop the labels.
export const legs = (t, list, { bare = false } = {}) => h_flex().gap(bare ? 2 : 4).items_end().flex_none()
  .children(list.map(({ label, state }) => {
    const mine = state === "you" || state === "acc";
    return v_flex().gap(3).when(bare, (el) => el.w(16))
      .when(!bare, (el) => el.child(div().text_size(11).text_color(state === "run" ? t.muted : stateTone(t, state, t.muted))
        .when(mine, (d) => d.font_semibold()).child(label)))
      .child(div().h(3).rounded(2).bg(stateTone(t, state, t.border)).when(state === "run", (d) => d.opacity(0.7)));
  }));

// A usage window: fill to the level, a tick where its time is (pace 0–1, like a quota window's).
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
export function band(t, width, pct, pace = null, { thin = false, tone = null } = {}) {
  const [bar, box, top] = thin ? [2, 5, 1.5] : [3, 7, 2], fill = clamp(pct, 0, 100);
  return div().relative().w(width).h(box).flex_none()
    .child(div().absolute().left(0).top(top).w(width).h(bar).rounded(2).bg(t.raised))
    .child(div().absolute().left(0).top(top).h(bar).rounded(2).bg(tone ?? quotaTone(t, fill)).w(Math.max(fill ? 2 : 0, Math.round((width * fill) / 100))))
    .when(pace != null, (el) => el.child(div().absolute().top(0).w(1).h(box).bg(t.foreground).opacity(0.7)
      .left(Math.round(width * clamp(pace, 0, 1)))));
}

// What a popup's key handler asks first: a chord is the app's, and 1–9 pick a numbered row.
export const held = (e) => Boolean(e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt);
export const digit = (e) => (/^[1-9]$/.test(e.key) ? Number(e.key) : null);

// An overlay takes the keyboard a moment after it opens, so focus is asked for now and again once it has.
export function grabFocus(handle, cx, still = () => true) {
  handle.focus();
  cx.timer.after(300, () => {
    if (still()) handle.focus();
  });
}

// Which folds are open, kept across reloads; a card's "more" lines are not kept.
export const FOLDS = "relevo.inbox.folds";
export function saveFolds(expanded) {
  const kept = Object.fromEntries(Object.entries(expanded).filter(([k, v]) => v && !k.startsWith("more-")));
  if (JSON.stringify(kept) !== JSON.stringify(shared(FOLDS) ?? {})) setShared(FOLDS, kept);
}

// Opens or shuts a fold and remembers it; `onOpen` runs when it opens. Every control of a fold goes through here.
export function toggleFold(view, key, cx, onOpen = null) {
  const open = Boolean(view.expanded[key]);
  view.expanded[key] = !open;
  saveFolds(view.expanded);
  if (!open) onOpen?.(cx);
  cx.notify();
}

// A "N things" line that folds a list open or shut; `key` names its state in view.expanded.
export function foldRow(view, t, id, key, label, { gap = false, onOpen = null, after = null } = {}) {
  const open = Boolean(view.expanded[key]);
  return Button.new(id).id(id).tab_index(0).selected(open).accessibility_label(`${label}. ${open ? "Collapse" : "Expand"}`)
    .tooltip(`${open ? "Collapse" : "Expand"} ${label}`).focus((el) => el.border_2().border_color(t.accent))
    .min_h(28).pl(LANE).pr(8).when(gap, (el) => el.pt(6)).when(!gap, (el) => el.py(2))
    .flex().items_center().gap(5).text_size(11).text_color(t.dim).cursor_pointer()
    .hover((s) => s.text_color(t.muted))
    .on_click((_e, cx) => {
      cx.stop_propagation();
      toggleFold(view, key, cx, onOpen);
    })
    .child(chevron(open))
    .child(label)
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

// Lines a change added and removed, in the diff's colors.
export const plusMinus = (t, added, removed) => [div().flex_none().text_size(11).text_color(t.ansi2).child(`+${added}`),
  div().flex_none().text_size(11).text_color(t.ansi1).child(`−${removed}`)];
