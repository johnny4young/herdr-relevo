// A recorded element tree as one HTML page with inline styles.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";

// The checkout this folder sits in, unless RELEVO_REPO names another.
export const REPO = process.env.RELEVO_REPO ?? fileURLToPath(new URL("../..", import.meta.url));
// Icons the app ships (mods/workspace-chrome, icons/) are read from its config folder, never written.
const ROOTS = [REPO, process.env.HERDR_APP_HOME ?? join(homedir(), ".config/herdr-app")];
// GPUI's default line height is the golden ratio; LINE_HEIGHT overrides it.
const LINE_HEIGHT = process.env.LINE_HEIGHT ?? "1.618";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const css = (style) => Object.entries(style).filter(([, v]) => v != null).map(([k, v]) => `${k}:${v}`).join(";");

const warned = new Set();
function asset(path) {
  for (const root of ROOTS) {
    const file = join(root, path);
    if (existsSync(file)) return readFileSync(file);
  }
  if (!warned.has(path)) {
    warned.add(path);
    process.stderr.write(`render: no file for ${path}\n`);
  }
  return null;
}
const mime = (path) => (path.endsWith(".svg") ? "image/svg+xml" : path.endsWith(".png") ? "image/png" : "image/jpeg");
const dataUri = (path, bytes) => `data:${mime(path)};base64,${bytes.toString("base64")}`;

const open = (node, style, cls = "g") =>
  `<div class="${cls}"${node.key != null ? ` data-id="${esc(node.key)}"` : ""} data-kind="${node.kind}" style="${esc(css(style))}">`;

// svg() paints the file's shape in the text colour, so it is drawn as a mask.
function icon(node) {
  const bytes = asset(node.path), style = { width: "16px", height: "16px", ...node.style };
  if (!bytes) return `${open(node, { ...style, outline: "1px dashed currentColor" })}</div>`;
  const uri = dataUri(node.path, bytes);
  return `${open(node, { ...style, "background-color": "currentColor", "-webkit-mask": `url(${uri}) center / contain no-repeat`, mask: `url(${uri}) center / contain no-repeat` })}</div>`;
}

function picture(node) {
  const bytes = asset(node.path);
  if (!bytes) return `${open(node, { ...node.style, outline: "1px dashed currentColor" })}</div>`;
  return `<img class="g" data-kind="image" src="${dataUri(node.path, bytes)}" style="${esc(css({ "object-fit": "contain", ...node.style }))}">`;
}

function field(node, theme) {
  const value = node.state?.value?.() ?? "", multi = node.kind !== "input";
  const shown = value || node.state?.placeholder || "";
  const box = { flex: "1 1 0%", "min-width": "0", display: "flex", "align-items": multi ? "flex-start" : "center", ...node.style };
  if (node.kind === "editor") box["font-family"] ??= '"JetBrains Mono", ui-monospace, monospace';
  const words = { "white-space": multi ? "pre-wrap" : "pre", overflow: "hidden", "text-overflow": "ellipsis", "min-width": "0", color: value ? null : theme.muted };
  return `${open(node, box)}<span style="${esc(css(words))}">${esc(shown)}</span></div>`;
}

function toggle(node, theme) {
  const on = Boolean(node.isSelected ?? node.isChecked), sw = node.kind === "switch";
  const box = { width: sw ? "28px" : "14px", height: sw ? "16px" : "14px", flex: "none", "border-radius": sw ? "8px" : "3px",
    border: `1px solid ${on ? theme.accent : theme.border}`, background: on ? theme.accent : "transparent", ...node.style };
  return `${open(node, box)}</div>`;
}

function draw(node, theme, parent) {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") {
    // Text in a flex box is an item of its own; a truncating parent passes the ellipsis on to it.
    if (parent?.style.display !== "flex") return esc(node);
    return `<span style="${parent.truncate ? "overflow:hidden;text-overflow:ellipsis;min-width:0" : ""}">${esc(node)}</span>`;
  }
  if (Array.isArray(node)) return node.map((n) => draw(n, theme, parent)).join("");
  if (node.kind === "svg") return icon(node);
  if (node.kind === "image") return picture(node);
  if (node.kind === "input" || node.kind === "textarea" || node.kind === "editor") return field(node, theme);
  if (node.kind === "checkbox" || node.kind === "switch") return toggle(node, theme);
  if (node.kind === "scrollbar") return "";
  return `${open(node, node.style)}${node.items.map((n) => draw(n, theme, node)).join("")}</div>`;
}

export function page(el, { width, height, theme, title = "render" }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,500;0,600;0,700;1,400&family=JetBrains+Mono:wght@400;500;600;700&display=block">
<style>
html, body { margin: 0; background: ${theme.chrome}; }
body { font-family: "Inter", -apple-system, "Helvetica Neue", sans-serif; font-size: 13px; line-height: ${LINE_HEIGHT}; color: ${theme.foreground};
  white-space: pre-wrap; overflow-wrap: anywhere; cursor: default; -webkit-font-smoothing: antialiased; }
#root { width: ${width}px; height: ${height}px; position: relative; overflow: hidden; }
.g { box-sizing: border-box; position: relative; border: 0 solid transparent; }
</style></head>
<body><div id="root">${draw(el, theme, null)}</div></body></html>
`;
}
