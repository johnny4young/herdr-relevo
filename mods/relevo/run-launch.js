// A worktree run between Start and its task: what it waits on, shared so Runs can show it wherever the person is.
import { exec } from "herdr";

export const RUN_LAUNCH = "relevo.runs.launch";

// A new worktree asks Claude and Codex whether to trust it: the keys that answer yes, or null. Pressed only on the
// person's click, since trusting lets the folder's own settings run.
export function trustKeys(screen) {
  if (/❯ Yes, I trust this folder/.test(screen)) return ["enter"];
  if (/❯ No, exit/.test(screen) && /Yes, I trust this folder/.test(screen)) return ["down", "enter"];
  if (/Trust this folder\?/.test(screen) && /› 1\. Trust and continue/.test(screen)) return ["enter"];
  return null;
}

// Answers yes only while the terminal still shows the question: a key sent to an agent that already started would type.
export async function answerTrust(address) {
  const screen = (await exec("hc", ["read", address, "--lines", "30"]).catch(() => null))?.stdout ?? "";
  const keys = trustKeys(screen);
  if (keys) await exec("hc", ["keys", address, ...keys]).catch(() => null);
  return Boolean(keys);
}
