// Hierarchy comes from weight and color, so the mods keep to two text sizes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { URL } from "node:url";

const SIZES = new Set(["11", "13"]);

test("mods only use the two text sizes", () => {
  for (const mod of ["relevo", "relevo-agents", "relevo-files"]) {
    const dir = new URL(`../../${mod}/`, import.meta.url);
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      for (const [, size] of readFileSync(new URL(name, dir), "utf8").matchAll(/text_size\(([\d.]+)\)/g)) {
        assert.ok(SIZES.has(size), `${mod}/${name} uses text_size(${size})`);
      }
    }
  }
});
