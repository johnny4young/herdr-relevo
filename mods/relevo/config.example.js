// Everything one setup needs: accounts, contexts, folders and skills. Copy to config.js and edit.

// Each Claude account: `launcher` is the shell command that starts it, `claudeDir` its
// CLAUDE_CONFIG_DIR under home, `bg`/`fg` its chip colors.
export const ACCOUNTS = [
  { key: "personal", label: "Personal", letter: "P", launcher: "claude", claudeDir: ".claude", bg: "#c3e88d", fg: "#1e2030" },
  {
    key: "work", label: "Work", letter: "W", launcher: "CLAUDE_CONFIG_DIR=$HOME/.claude-work claude", claudeDir: ".claude-work",
    bg: "#82aaff", fg: "#1e2030",
  },
];

export const CODEX = { key: "codex", label: "Codex", letter: "X", launcher: "codex", bg: "#4fd6be", fg: "#1e2030" };

// The first context is the default. The others claim the repos whose GitHub owner is in `orgs`,
// and each gets a space folder with that key.
export const CONTEXTS = [
  { key: "personal", label: "Personal", account: "personal", color: "ansi2" },
  { key: "work", label: "Work", account: "work", color: "ansi4", orgs: ["your-org"] },
];

// Who takes over when the repo's account is out of quota, in order.
export const FALLBACK = ["personal", "work"];

// Clones live directly under this folder in home.
export const REPOS_ROOT = "code";

// The slash commands the Inbox launches on a PR: a review, a CI fix and answering review comments.
export const SKILLS = { review: "review", fix: "fix-ci", comments: "address-comments" };
