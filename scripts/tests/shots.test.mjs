// The README's pictures keep drawing: every panel of scripts/shots/readme.mjs builds its HTML from the mods (no Chrome).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { PANELS, PICTURES } from "../shots/readme.mjs";

const shots = fileURLToPath(new URL("../shots/", import.meta.url));

test("every README panel draws from the mods, and every picture names panels and terminals that exist", () => {
  const work = mkdtempSync(join(tmpdir(), "relevo-shots-test-"));
  try {
    for (const [name, scene, size, env = {}] of PANELS) {
      const [width, height] = size.split("x");
      execFileSync(process.execPath, ["--import", join(shots, "register.mjs"), join(shots, "shoot.mjs"), join(shots, "scenes", `${scene}.mjs`), join(work, `${name}.png`),
        "--width", width, "--height", height, "--html-only"], { env: { ...process.env, HERDR_APP_HOME: work, ...env }, stdio: ["ignore", "ignore", "pipe"] });
      const html = readFileSync(join(work, `${name}.html`), "utf8");
      assert.match(html, /data-kind=/, name);
      assert.doesNotMatch(html, /\/Users\//, `${name} carries no machine path`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const names = new Set(PANELS.map(([name]) => name));
  for (const [file, , frames] of PICTURES) {
    for (const frame of frames) {
      const [kind, ref] = frame.split(":");
      if (kind === "term") assert.ok(existsSync(join(shots, "terms", `${ref}.txt`)), `${file}: terms/${ref}.txt`);
      else assert.ok(names.has(kind), `${file}: ${kind}`);
    }
  }
});
