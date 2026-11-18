// node scripts/shots/readme.mjs [--only name,name]: draws the README's preview and pictures from the mods with demo data.
// Needs Google Chrome (CHROME names another); fails when a picture comes out empty.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url)), repo = fileURLToPath(new URL("../..", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Panels: name, scene, size, environment.
export const PANELS = [
  ["now850", "inbox-sel", "380x850"], ["now510", "inbox-sel", "380x510"], ["leftbar850", "leftbar", "268x850", { HEIGHT: "850" }],
  ["away", "states", "380x558", { STATE: "away" }], ["review", "review", "700x598"], ["accounts", "accounts", "420x478"],
  ["maintenance", "maintenance", "380x638"], ["checks", "inbox-checks", "380x638", { SEL: "pr-https://github.com/acme/web/pull/318" }],
  ["spaces", "spaces", "268x638"], ["agents638", "agents-today", "268x638"],
  ["runs-run", "runs", "400x638", { RUN: "g1" }], ["runs-task", "runs", "400x638", { RUN: "g1", TASK: "t1", TWICE: "1" }],
  ["deep-review", "deep-review", "400x638"], ["deep-fix", "deep-review", "400x638", { VIEW: "fix" }],
];
// Pictures: file in the repo, page size, frames (a panel at its size, or a drawn terminal).
export const PICTURES = [
  ["preview.png", "1440x900", ["leftbar850:268x852", "term:work:700x852", "now850:380x852"]],
  ["screenshots/answer.png", "1100x560", ["term:answer:640x512", "now510:380x512"]],
  ["screenshots/away.png", "428x608", ["away:380x560"]],
  ["screenshots/review.png", "748x648", ["review:700x600"]],
  ["screenshots/handoff.png", "468x528", ["accounts:420x480"]],
  ["screenshots/worktrees.png", "428x688", ["maintenance:380x640"]],
  ["screenshots/land.png", "428x688", ["checks:380x640"]],
  ["screenshots/runs.png", "888x688", ["runs-run:400x640", "runs-task:400x640"]],
  ["screenshots/deep-review.png", "888x688", ["deep-review:400x640", "deep-fix:400x640"]],
  ["screenshots/spaces.png", "624x688", ["spaces:268x640", "agents638:268x640"]],
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!existsSync(CHROME)) { console.error(`readme: needs Google Chrome at ${CHROME} (or CHROME=...)`); process.exit(1); }
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;
  const pictures = PICTURES.filter(([file]) => !only || only.some((n) => file.includes(n)));
  if (!pictures.length) { console.error(`readme: no picture matches ${only}`); process.exit(1); }
  const work = mkdtempSync(join(tmpdir(), "relevo-readme-"));
  try {
    const wanted = new Set(pictures.flatMap(([, , frames]) => frames.filter((f) => !f.startsWith("term:")).map((f) => f.split(":")[0])));
    for (const [name, scene, size, env = {}] of PANELS.filter(([name]) => wanted.has(name))) {
      const [width, height] = size.split("x");
      execFileSync(process.execPath, ["--import", join(here, "register.mjs"), join(here, "shoot.mjs"), join(here, "scenes", `${scene}.mjs`), join(work, `${name}.png`),
        "--width", width, "--height", height, "--html-only"], { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "inherit"] });
    }
    for (const [file, size, frames] of pictures) {
      const args = frames.map((f) => (f.startsWith("term:") ? `term:${join(here, "terms", `${f.split(":")[1]}.txt`)}:${f.split(":")[2]}` : `${join(work, `${f.split(":")[0]}.html`)}:${f.split(":")[1]}`));
      const out = join(work, file.replaceAll("/", "-"));
      execFileSync(process.execPath, [join(here, "compose.mjs"), out, size, ...args], { stdio: ["ignore", "ignore", "inherit"] });
      if (!statSync(out, { throwIfNoEntry: false })?.size) throw new Error(`readme: ${file} came out empty`);
      copyFileSync(out, join(repo, file));
      console.log(file);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
