import { appHome, exec, readTextFile } from "herdr";

// The Herdr app's PATH lacks what a login shell adds (fnm, nvm, Homebrew); the installer records the node it ran with.
let found = null;
export async function nodeBin() {
  if (found) return found;
  const path = String(await readTextFile(`${appHome()}/relevo-install/node`).catch(() => null) ?? "").trim();
  if (path.startsWith("/")) found = path;
  return found ?? "node";
}

// The run state, read whole: readTextFile stops at 1 MiB, which a queue of finished tasks passes. `rev` is state.rev's
// text: with it there is a state, so a read that failed or came back empty goes through cat. null: no state yet.
export async function readRunState(rev) {
  const path = `${appHome()}/relevo-workflow/state.json`;
  const small = await readTextFile(path).catch(() => undefined);
  if (typeof small === "string" || (small === null && rev == null)) return small;
  const r = await exec("cat", [path]).catch(() => null);
  return r?.code === 0 ? r.stdout : null;
}

// Runs one command of the run coordinator (runtime/cli.mjs) and returns exec's result.
export async function runtimeCommand(payload) {
  return exec(await nodeBin(), [`${appHome()}/mods/relevo/runtime/cli.mjs`, "--home", appHome(), "command", JSON.stringify(payload)]);
}
