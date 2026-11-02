// A new agent on a PR in its own worktree, and the skill usage the PR menu ranks by.
import { exec, home, run, spaces, notify } from "herdr";
import { ACCOUNTS, CODEX, accountOf, launchArgv } from "./accounts.js";
import { checkoutOf } from "./worktrees.js";
import { parseUses, worktreePath, localBranch, checkoutArgs, sessionPrompt } from "./lib/prmenu.js";

const HOUR = 3600 * 1000;
let uses = null;

// How often each slash command was typed in any account's Claude history, read at most once an hour.
export async function skillUses() {
  if (uses && Date.now() - uses.at < HOUR) return uses.counts;
  const files = [...new Set(ACCOUNTS.filter((a) => a.claudeDir).map((a) => `${home()}/${a.claudeDir}/history.jsonl`))];
  const r = await exec("sh", ["-c", 'for f; do [ -f "$f" ] && grep -oE \'"display":"/[A-Za-z0-9:._-]+\' "$f"; done | sort | uniq -c', "sh", ...files]);
  uses = { at: Date.now(), counts: parseUses(r.stdout) };
  return uses.counts;
}

// The PR's branch in a new worktree (or the checkout it already has), then the account's agent there.
// gh pr checkout fetches the branch, forks included. Resolves to an error message, or null.
// Someone else's fork can carry hooks in its project settings, so Claude starts without them
// and Codex, which has no such switch, doesn't open it.
export async function openPrSession(pr, clone, account) {
  if (pr.untrusted && account === CODEX.key) return "Codex can't open a fork's code without its project settings";
  const branch = localBranch(pr);
  let path = await checkoutOf(clone, branch);
  if (!path) {
    path = worktreePath(home(), pr.repo, branch);
    if ((await exec("test", ["-e", path])).code === 0) return `${path} already exists`;
    const add = await exec("git", ["-C", clone, "worktree", "add", "--detach", path]);
    if (add.code !== 0) return add.stderr.trim().split("\n").pop() || "git worktree add failed";
    const co = await exec("gh", checkoutArgs(pr), { cwd: path });
    if (co.code !== 0) {
      await exec("git", ["-C", clone, "worktree", "remove", "--force", path]);
      return co.stderr.trim().split("\n").pop() || "gh pr checkout failed";
    }
  } else notify({ title: `${branch} is already checked out`, body: path, level: "info", timeout: 3000 });
  const argv = launchArgv(account, sessionPrompt(pr), pr.untrusted ? ["--setting-sources", "user"] : []), tab = `${pr.repo.split("/").pop()}#${pr.number} · ${accountOf(account).letter}`;
  // Unnamed, like the worktree mod's spaces, so it follows the folder and nests under the repo.
  const space = spaces().find((s) => !s.machine && s.folder === path);
  if (space) run("tab.new", { space: space.id, name: tab, folder: path, argv });
  else run("space.new", { folder: path, tab, argv });
  return null;
}
