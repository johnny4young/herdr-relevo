// gpui-kit stand-in: elements record every style call as CSS, so html.mjs can draw the tree.
import { setImmediate } from "node:timers";

const len = (v) => (typeof v === "number" ? `${v}px` : String(v));
const tw = (v) => (v === "full" ? "100%" : v === "auto" ? "auto" : v === "px" ? "1px" : `${Number(v) * 4}px`);
const SIDES = { t: ["top"], b: ["bottom"], l: ["left"], r: ["right"], x: ["left", "right"], y: ["top", "bottom"] };
const CORNERS = {
  tl: ["top-left"], tr: ["top-right"], bl: ["bottom-left"], br: ["bottom-right"],
  t: ["top-left", "top-right"], b: ["bottom-left", "bottom-right"], l: ["top-left", "bottom-left"], r: ["top-right", "bottom-right"],
};
const RADII = { none: 0, xs: 2, sm: 4, md: 6, lg: 8, xl: 12, "2xl": 16, "3xl": 24, full: 9999 };
const TEXT = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, "2xl": 24, "3xl": 30 };
const WEIGHTS = { thin: 100, extralight: 200, light: 300, normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 };
const ALIGN = { start: "flex-start", end: "flex-end", center: "center", between: "space-between", around: "space-around", evenly: "space-evenly", stretch: "stretch", baseline: "baseline" };
const SHADOWS = { xs: "0 1px 1px #0000000d", sm: "0 1px 2px #0000001a", md: "0 4px 6px #0000001a", lg: "0 10px 15px #0000001a", xl: "0 20px 25px #0000001a" };

// Calls with no visual effect in a still picture.
const QUIET = new Set([
  "tooltip", "accessibility_label", "accessibility_description", "role", "tab_index", "tab_stop", "track_focus", "track_scroll",
  "hover", "focus", "focus_visible", "active", "group", "group_hover", "loop", "transition", "mode", "selectable", "occlude",
  "key_context", "debug_selector", "visible_on_hover", "window_drag",
]);

const set = (css) => (n) => void Object.assign(n.style, css);
const EXACT = {
  flex: set({ display: "flex" }), block: set({ display: "block" }), hidden: set({ display: "none" }),
  flex_row: set({ "flex-direction": "row" }), flex_col: set({ "flex-direction": "column" }),
  h_flex: set({ display: "flex", "flex-direction": "row", "align-items": "center" }), v_flex: set({ display: "flex", "flex-direction": "column" }),
  flex_wrap: set({ "flex-wrap": "wrap" }), flex_nowrap: set({ "flex-wrap": "nowrap" }),
  flex_1: set({ flex: "1 1 0%" }), flex_none: set({ flex: "none" }), flex_auto: set({ flex: "1 1 auto" }), flex_initial: set({ flex: "0 1 auto" }),
  flex_grow: set({ "flex-grow": "1" }), flex_shrink: set({ "flex-shrink": "1" }), flex_shrink_0: set({ "flex-shrink": "0" }),
  flex_basis: (n, v) => void (n.style["flex-basis"] = len(v)),
  gap: (n, v) => void (n.style.gap = len(v)), gap_x: (n, v) => void (n.style["column-gap"] = len(v)), gap_y: (n, v) => void (n.style["row-gap"] = len(v)),
  size: (n, v) => void Object.assign(n.style, { width: len(v), height: len(v) }),
  bg: (n, c) => void (n.style.background = c), text_color: (n, c) => void (n.style.color = c), text_bg: (n, c) => void (n.textBg = c),
  border_color: (n, c) => void (n.style["border-color"] = c),
  text_size: (n, v) => void (n.style["font-size"] = len(v)), line_height: (n, v) => void (n.style["line-height"] = typeof v === "number" ? String(v) : v),
  font_family: (n, v) => void (n.style["font-family"] = `"${v}", ui-monospace, monospace`), font_weight: (n, v) => void (n.style["font-weight"] = String(v)),
  italic: set({ "font-style": "italic" }), not_italic: set({ "font-style": "normal" }), underline: set({ "text-decoration": "underline" }),
  line_through: set({ "text-decoration": "line-through" }),
  text_left: set({ "text-align": "left" }), text_right: set({ "text-align": "right" }), text_center: set({ "text-align": "center" }),
  truncate: (n) => { n.truncate = true; Object.assign(n.style, { overflow: "hidden", "text-overflow": "ellipsis", "white-space": "pre" }); },
  text_ellipsis: set({ "text-overflow": "ellipsis" }),
  whitespace_nowrap: set({ "white-space": "pre" }), whitespace_normal: set({ "white-space": "pre-wrap" }),
  line_clamp: (n, v) => void Object.assign(n.style, { display: "-webkit-box", "-webkit-line-clamp": String(v), "-webkit-box-orient": "vertical", overflow: "hidden" }),
  opacity: (n, v) => void (n.style.opacity = String(v)),
  absolute: set({ position: "absolute" }), relative: set({ position: "relative" }),
  inset: (n, v) => void (n.style.inset = len(v)), inset_0: set({ inset: "0" }),
  top: (n, v) => void (n.style.top = len(v)), bottom: (n, v) => void (n.style.bottom = len(v)),
  left: (n, v) => void (n.style.left = len(v)), right: (n, v) => void (n.style.right = len(v)),
  invisible: set({ visibility: "hidden" }), shadow: set({ "box-shadow": SHADOWS.sm }), shadow_none: set({ "box-shadow": "none" }),
  // Chrome runs with --hide-scrollbars; a scroll area just clips.
  overflow_hidden: set({ overflow: "hidden" }),
};

const PATTERNS = [
  [/^(min_|max_)?(w|h)$/, (n, m, v) => void (n.style[`${(m[1] ?? "").replace("_", "-")}${m[2] === "w" ? "width" : "height"}`] = len(v))],
  [/^(min_|max_)?(w|h|size)_(full|auto|px|\d+(?:\.\d+)?)$/, (n, m) => {
    for (const d of m[2] === "size" ? ["width", "height"] : [m[2] === "w" ? "width" : "height"]) n.style[`${(m[1] ?? "").replace("_", "-")}${d}`] = tw(m[3]);
  }],
  [/^(p|m)([tblrxy])?$/, (n, m, v) => {
    const prop = m[1] === "p" ? "padding" : "margin";
    if (!m[2]) n.style[prop] = len(v);
    else for (const s of SIDES[m[2]]) n.style[`${prop}-${s}`] = len(v);
  }],
  [/^(p|m)([tblrxy])?_(auto|px|\d+(?:\.\d+)?)$/, (n, m) => {
    const prop = m[1] === "p" ? "padding" : "margin";
    if (!m[2]) n.style[prop] = tw(m[3]);
    else for (const s of SIDES[m[2]]) n.style[`${prop}-${s}`] = tw(m[3]);
  }],
  [/^gap(_[xy])?_(px|\d+(?:\.\d+)?)$/, (n, m) => void (n.style[m[1] === "_x" ? "column-gap" : m[1] === "_y" ? "row-gap" : "gap"] = tw(m[2]))],
  [/^border(?:_([tblrxy]))?(?:_(\d+))?$/, (n, m, v) => {
    const w = len(v ?? Number(m[2] ?? 1));
    if (!m[1]) n.style["border-width"] = w;
    else for (const s of SIDES[m[1]]) n.style[`border-${s}-width`] = w;
  }],
  [/^border_dashed$/, (n) => void (n.style["border-style"] = "dashed")],
  [/^rounded(?:_(tl|tr|bl|br|t|b|l|r))?(?:_(none|xs|sm|md|lg|xl|2xl|3xl|full))?$/, (n, m, v) => {
    const r = len(v ?? RADII[m[2] ?? "md"]);
    if (!m[1]) n.style["border-radius"] = r;
    else for (const c of CORNERS[m[1]]) n.style[`border-${c}-radius`] = r;
  }],
  [/^text_(xs|sm|base|lg|xl|2xl|3xl)$/, (n, m) => void (n.style["font-size"] = `${TEXT[m[1]]}px`)],
  [/^font_(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/, (n, m) => void (n.style["font-weight"] = String(WEIGHTS[m[1]]))],
  [/^items_(start|end|center|stretch|baseline)$/, (n, m) => void (n.style["align-items"] = ALIGN[m[1]])],
  [/^justify_(start|end|center|between|around|evenly)$/, (n, m) => void (n.style["justify-content"] = ALIGN[m[1]])],
  [/^self_(start|end|center|stretch)$/, (n, m) => void (n.style["align-self"] = ALIGN[m[1]])],
  [/^content_(start|end|center|between|around|stretch)$/, (n, m) => void (n.style["align-content"] = ALIGN[m[1]])],
  [/^overflow(?:_([xy]))?_(hidden|scroll|scrollbar|visible)$/, (n, m) => {
    n.style[m[1] ? `overflow-${m[1]}` : "overflow"] = m[2] === "visible" ? "visible" : "hidden";
  }],
  [/^shadow_(xs|sm|md|lg|xl)$/, (n, m) => void (n.style["box-shadow"] = SHADOWS[m[1]])],
  [/^cursor_\w+$/, () => {}],
  [/^on_\w+$/, () => {}],
  [/^aria_\w+$/, () => {}],
];

// Every builder method a mod called that has no CSS here, with how often.
export const unmapped = new Map();
function miss(kind, name) {
  const key = `${kind}.${name}`;
  if (!unmapped.has(key)) process.stderr.write(`render: unmapped ${key}()\n`);
  unmapped.set(key, (unmapped.get(key) ?? 0) + 1);
}

const BASE = {
  h_flex: { display: "flex", "flex-direction": "row", "align-items": "center" },
  v_flex: { display: "flex", "flex-direction": "column" },
  // gpui-base's Button is unstyled; this assumes its interior is a centered row holding the children directly.
  button: { display: "flex", "flex-direction": "row", "align-items": "center" },
};

export function element(kind = "div", extra = {}) {
  const node = { kind, key: null, items: [], style: { ...BASE[kind] }, handlers: {}, tip: null, ...extra };
  const el = new Proxy(node, {
    get(target, name) {
      if (name in target) return target[name];
      if (typeof name === "symbol" || name === "then" || name === "toJSON") return undefined;
      return (...args) => {
        if (name === "id") target.key = args[0];
        else if (name === "child") target.items.push(args[0]);
        else if (name === "children") target.items.push(...args[0]);
        else if (name === "when") { if (args[0]) args[1](el); }
        else if (name === "when_some") { if (args[0] != null) args[1](el, args[0]); }
        else if (name === "map") return args[0](el);
        else if (name === "disabled") target.isDisabled = args[0] ?? true;
        else if (name === "selected") target.isSelected = args[0] ?? true;
        else if (name === "spin") target.spinning = true;
        else if (name === "tooltip") target.tip = args[0];
        else if (name.startsWith("on_")) target.handlers[typeof args[0] === "string" ? `${name}:${args[0]}` : name] = args.at(-1);
        else if (QUIET.has(name)) return el;
        else if (EXACT[name]) EXACT[name](target, ...args);
        else {
          const hit = PATTERNS.map(([re, fn]) => [re.exec(name), fn]).find(([m]) => m);
          if (hit) hit[1](target, hit[0], ...args);
          else miss(kind, name);
        }
        return el;
      };
    },
  });
  return el;
}

export class View {}
export const div = () => element("div");
export const svg = (path) => element("svg", { path });
export const image = (path) => element("image", { path });
// A virtual list draws every item, top to bottom, like a flex column.
export const list = (id, count = 0, key = String, render = () => null) =>
  element("list").id(id).flex().flex_col().children(Array.from({ length: count }, (_, i) => render(i)).filter(Boolean));

const kids = (node) => (node && typeof node === "object" ? node.items ?? [] : []);
export function find(root, id) {
  if (root?.key === id) return root;
  for (const child of kids(root)) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
}
export const text = (node) => (typeof node === "string" || typeof node === "number" ? String(node) : kids(node).map(text).filter(Boolean).join(" "));

// The context a mod's init/render/handlers get. `focused: true` draws the view as holding the keyboard.
export function fakeCx({ focused = false } = {}) {
  const timers = [];
  const cx = {
    timers, notified: 0, slept: [],
    notify() { cx.notified += 1; },
    stop_propagation() {},
    spawn(body) { return Promise.resolve().then(() => body(cx)); },
    sleep: async (ms) => { cx.slept.push(ms); },
    focus_handle: () => ({ focus() {}, is_focused: () => focused, release() {} }),
    timer: { every: (ms, fn) => void timers.push({ ms, fn }), after: (ms, fn) => void timers.push({ ms, fn, once: true }) },
    fire: (ms) => timers.filter((t) => t.ms === ms && !t.once).forEach((t) => t.fn(cx)),
  };
  return cx;
}
export const click = (node, cx) => node.handlers.on_click({}, cx);
export async function flush() {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}
