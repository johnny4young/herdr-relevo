// Lists the builder-looking method names in the repo's mods that kit.mjs has no CSS for.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { element, unmapped } from "./kit.mjs";
import { REPO } from "./html.mjs";

const names = new Map();
for (const mod of readdirSync(join(REPO, "mods"))) {
  for (const file of readdirSync(join(REPO, "mods", mod)).filter((f) => f.endsWith(".js"))) {
    for (const [, name] of readFileSync(join(REPO, "mods", mod, file), "utf8").matchAll(/\.([a-z][a-z_0-9]*)\(/g)) names.set(name, (names.get(name) ?? 0) + 1);
  }
}
const write = process.stderr.write;
process.stderr.write = () => true;
for (const name of names.keys()) { try { element("div")[name](1, () => {}); } catch { /* not a builder call */ } }
process.stderr.write = write;
console.log([...unmapped.keys()].map((k) => k.slice(4)).filter((n) => n.includes("_")).map((n) => `${n}×${names.get(n)}`).join("  "));
