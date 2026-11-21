import { appHome, checking, exec, notify, readTextFile, writeTextFile } from "herdr";
import { RELEVO_MODS, SMOKE_FILE, smoke, smokeDue, smokeRecord, versions } from "./lib/smoke.js";

const run = (command, args) => exec(command, args, { timeout: 120000 });
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

// Once per new herdr-app/hc pair; quiet when it passes. `herdr-app check` loads this mod too, so it never runs there.
export async function smokeAfterUpdate() {
  if (checking()) return null;
  const file = `${appHome()}/${SMOKE_FILE}`, text = await readTextFile(file);
  if (!smokeDue(parse(text), await versions(run))) return null;
  const modsDir = `${appHome()}/mods`, installed = [];
  for (const mod of RELEVO_MODS) if ((await readTextFile(`${modsDir}/${mod}/mod.json`)) !== null) installed.push(mod);
  const result = await smoke({ run, modsDir, installed });
  await writeTextFile(file, `${JSON.stringify(smokeRecord(result), null, 2)}\n`, text).catch(() => {});
  if (result.failed) {
    const first = result.results.find((r) => r.level === "fail")?.text;
    notify({ level: "error", title: `Relevo may not work with Herdr ${result.app ?? ""}`.trim(), body: `${first}. More: node scripts/relevo.mjs smoke`, timeout: 30000 });
  }
  return result;
}
