import { appHome, exec, readTextFile } from "herdr";

// The Herdr app's PATH lacks what a login shell adds (fnm, nvm, Homebrew); the installer records the node it ran with.
let found = null;
export async function nodeBin() {
  if (found) return found;
  const path = String(await readTextFile(`${appHome()}/relevo-install/node`).catch(() => null) ?? "").trim();
  if (path.startsWith("/")) found = path;
  return found ?? "node";
}

// Runs one command of the run coordinator (runtime/cli.mjs) and returns exec's result.
export async function runtimeCommand(payload) {
  return exec(await nodeBin(), [`${appHome()}/mods/relevo/runtime/cli.mjs`, "--home", appHome(), "command", JSON.stringify(payload)]);
}
