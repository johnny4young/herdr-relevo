// node compose.mjs <out.png> <W>x<H> <frame>...  frame: path/to/panel.html:WxH | term:file.txt:WxH. Panels side by side on the app's backdrop.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [out, size, ...frames] = process.argv.slice(2);
const [W, H] = size.split("x").map(Number);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const tint = (line) => {
  if (line.startsWith("● ")) return `<span style="color:#c3e88d">●</span> ${esc(line.slice(2))}`;
  if (line.startsWith("✓ ")) return `<span style="color:#c3e88d">✓</span> ${esc(line.slice(2))}`;
  if (line.startsWith("✗ ")) return `<span style="color:#ff757f">✗ ${esc(line.slice(2))}</span>`;
  if (line.startsWith("> ")) return `<span style="color:#828bb8">›</span> ${esc(line.slice(2))}`;
  if (line.startsWith("# ")) return `<b style="color:#c8d3f5">${esc(line.slice(2))}</b>`;
  if (line.startsWith("~ ")) return `<span style="color:#636da6">${esc(line.slice(2))}</span>`;
  if (line.startsWith("* ")) return `<span style="color:#ffc777">${esc(line.slice(2))}</span>`;
  return esc(line);
};
const cells = frames.map((f) => {
  const [kind, path, dim] = f.startsWith("term:") ? f.split(":") : ["panel", ...f.split(":")];
  const [w, h] = dim.split("x").map(Number);
  if (kind === "term") {
    const [title, ...lines] = readFileSync(resolve(path), "utf8").trimEnd().split("\n");
    return `<div style="width:${w}px;height:${h}px;border:1px solid #3b4261;border-radius:10px;background:#1e2030;display:flex;flex-direction:column;overflow:hidden">
<div style="height:36px;display:flex;align-items:center;gap:8px;padding:0 14px;border-bottom:1px solid #2f334d;font:13px Inter,system-ui;color:#c8d3f5"><span style="background:#82aaff;color:#1e2030;border-radius:4px;font-size:11px;font-weight:700;padding:1px 5px">W</span>Claude Code <span style="color:#636da6">${esc(title)}</span></div>
<pre style="margin:0;padding:16px 18px;font:13px/1.75 'JetBrains Mono',ui-monospace,Menlo,monospace;color:#c8d3f5;white-space:pre-wrap">${lines.map(tint).join("\n")}</pre></div>`;
  }
  return `<iframe src="${pathToFileURL(resolve(path)).href}" style="width:${w}px;height:${h}px;border:1px solid #3b4261;border-radius:10px;overflow:hidden;background:#222436" scrolling="no"></iframe>`;
});
const html = resolve(out).replace(/\.png$/, ".compose.html");
writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#191a26;width:${W}px;height:${H}px;display:flex;gap:20px;padding:24px;box-sizing:border-box;align-items:flex-start}</style>${cells.join("")}`);
rmSync(out, { force: true });
const profile = mkdtempSync(join(tmpdir(), "relevo-shots-"));
process.on("exit", () => rmSync(profile, { recursive: true, force: true }));
execFileSync(CHROME, ["--headless=new", "--hide-scrollbars", "--force-device-scale-factor=2", `--window-size=${W},${H}`, "--no-first-run",
  `--user-data-dir=${profile}`, "--allow-file-access-from-files", "--virtual-time-budget=5000", `--screenshot=${resolve(out)}`, pathToFileURL(html).href],
  { stdio: ["ignore", "ignore", "pipe"], timeout: 60000 });
if (!statSync(out, { throwIfNoEntry: false })?.size) { console.error("compose: no screenshot"); process.exit(1); }
console.log(out);
