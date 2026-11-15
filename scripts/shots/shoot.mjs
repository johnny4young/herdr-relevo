// node --import ./register.mjs shoot.mjs <scene.mjs> <out.png> [--width W --height H --scale 2] [--html-only]
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { fake, resetFake, theme, themeName } from "./herdr.mjs";
import { fakeCx, flush, find, click, unmapped } from "./kit.mjs";
import { page, REPO } from "./html.mjs";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const [sceneFile, outFile, ...rest] = process.argv.slice(2);
if (!sceneFile || !outFile) {
  console.error("usage: node --import ./register.mjs shoot.mjs <scene.mjs> <out.png> [--width W --height H --scale 2]");
  process.exit(2);
}
const htmlOnly = rest.includes("--html-only"), flags = {};
const sized = rest.filter((a) => a !== "--html-only");
for (let i = 0; i < sized.length; i += 2) flags[sized[i].replace(/^--/, "")] = Number(sized[i + 1]);

const scene = (await import(pathToFileURL(resolve(sceneFile)).href)).default;
if (typeof scene !== "function") throw new Error(`${sceneFile} has no default export function`);
// load("mods/relevo/inbox.js") imports a module of the repo, through the fakes.
const load = (path) => import(pathToFileURL(join(REPO, path)).href);
const made = await scene({ fake, resetFake, theme: theme(), themeName, cx: fakeCx(), fakeCx, flush, find, click, load, repo: REPO });
const el = made?.el ?? made;
if (!el || typeof el !== "object" || !("items" in el)) throw new Error(`${sceneFile} returned no element`);
const width = flags.width || made.width || 380, height = flags.height || made.height || 800, scale = flags.scale || 2;

const png = resolve(outFile), html = png.replace(/\.png$/i, "") + ".html";
mkdirSync(dirname(png), { recursive: true });
writeFileSync(html, page(el, { width, height, theme: theme(), title: `${sceneFile} · ${themeName}` }));
rmSync(png, { force: true });
if (htmlOnly) {
  console.log(html);
  process.exit(0);
}

// Its own profile, so a running Chrome is left alone.
const profile = mkdtempSync(join(tmpdir(), "relevo-shots-"));
process.on("exit", () => rmSync(profile, { recursive: true, force: true }));
execFileSync(CHROME, [
  "--headless=new", "--hide-scrollbars", `--force-device-scale-factor=${scale}`, `--window-size=${width},${height}`,
  "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`,
  "--virtual-time-budget=5000", "--default-background-color=00000000", `--screenshot=${png}`, pathToFileURL(html).href,
], { stdio: ["ignore", "ignore", "pipe"], timeout: 60000 });

if (!statSync(png, { throwIfNoEntry: false })?.size) {
  console.error(`render: Chrome wrote no screenshot at ${png}`);
  process.exit(1);
}
console.log(`${png}  ${width}x${height} @${scale}x  theme=${themeName}`);
if (unmapped.size) console.log(`unmapped: ${[...unmapped].map(([k, n]) => `${k}×${n}`).join(", ")}`);
process.exit(0);
