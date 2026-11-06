// Herdr's mod runtime has no browser or Node timers: a call to one throws, and takes the caller down with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { URL } from "node:url";

test("mods never call setTimeout or setInterval; cx.timer is the one there is", () => {
  for (const mod of ["relevo", "relevo-agents", "relevo-files"]) {
    for (const sub of ["", "lib/"]) {
      const dir = new URL(`../../${mod}/${sub}`, import.meta.url);
      let names = [];
      try {
        names = readdirSync(dir).filter((f) => f.endsWith(".js"));
      } catch {
        continue;
      }
      for (const name of names) {
        const code = readFileSync(new URL(name, dir), "utf8").replace(/\/\/.*$/gm, "");
        assert.doesNotMatch(code, /\bset(Timeout|Interval)\s*\(/, `${mod}/${sub}${name}`);
      }
    }
  }
});
