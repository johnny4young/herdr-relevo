// What each agent CLI can do, so features ask a provider instead of comparing account keys. Pure.
// A provider without several accounts has one account, whose key is the provider's key.

// What a run's Claude agent may not edit in the app folder: its state, locks, mods or settings. A bare "*" would also
// match the reports folder: app files all carry an extension, folders are listed.
const APP_DIRS = ["mods", "data", "layouts", "themes", "icons", "frame", "telemetry", "relevo-workflow/artifacts", "relevo-workflow/archive"];

export const PROVIDERS = {
  claude: {
    key: "claude",
    name: "Claude Code",
    short: "Claude",
    bin: "claude",
    // What Herdr reports as the terminal's agent or app.
    apps: ["claude", "claude-code"],
    // Its id in `herdr integration status`: the hook that tells Herdr the agent's state.
    integration: "claude",
    models: ["opus", "sonnet", "haiku"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    // accounts: several logins side by side; fork: resume a copy of another account's conversation;
    // writer: offered first to write a run, so another provider reviews it; runs: Relevo knows how to run it unattended
    // (Runs, Deep review).
    caps: { accounts: true, fork: true, quota: true, usage: true, skills: true, writer: false, runs: true },
    // The arguments that start it on a first prompt.
    promptArgs: (prompt) => [prompt],
    defaultModel: () => "",
    // Where its session logs live, for the token scan.
    usageDirs: (a, home) => (a.claudeDir ? [`${home}/${a.claudeDir}/projects`] : []),
    modelArgs: (r, base) => [...base, ...(r.model ? ["--model", r.model] : []), ...(r.effort ? ["--effort", r.effort] : [])],
    // Auto mode in its own worktree; RUN_SANDBOX also keeps Bash in the OS sandbox. A reviewer starts without the
    // person's hooks, since one that asks for something else pulls it off the review.
    runArgs({ role, home, sandboxed }) {
      const reports = `${home}/relevo-workflow/reports`;
      const deny = ["*.*", "relevo-workflow/*.*", ...APP_DIRS.map((dir) => `${dir}/**`)].map((glob) => `Edit(/${home}/${glob})`);
      const settings = { ...(sandboxed ? { sandbox: { enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true, autoAllowBashIfSandboxed: true } } : {}),
        permissions: { allow: [`Edit(/${reports}/*.json)`], deny }, ...(role === "reviewer" ? { disableAllHooks: true } : {}) };
      return ["--add-dir", reports, "--permission-mode", "auto", "--settings", JSON.stringify(settings), ...(role === "reviewer" ? ["--tools", "Read,Write,Grep,Glob"] : [])];
    },
  },
  codex: {
    key: "codex",
    name: "Codex",
    short: "Codex",
    bin: "codex",
    apps: ["codex"],
    integration: "codex",
    chip: { label: "Codex", letter: "X", bg: "#4fd6be", fg: "#1e2030" },
    // Its model is config's RUN_CODEX_MODEL: no list to pick from.
    models: [],
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
    caps: { accounts: false, fork: false, quota: true, usage: true, skills: false, writer: true, runs: true },
    promptArgs: (prompt) => [prompt],
    defaultModel: (config) => config?.RUN_CODEX_MODEL ?? "gpt-6-luna",
    usageDirs: (_a, home) => [`${home}/.codex/sessions`, `${home}/.codex/archived_sessions`],
    // Its model goes with -m, already in a run's base flags, and its effort as a config override.
    modelArgs(r, base) {
      const args = [...base], at = args.indexOf("-m");
      if (r.model && at >= 0) args[at + 1] = r.model;
      return r.effort ? [...args, "-c", `model_reasoning_effort="${r.effort}"`] : args;
    },
    // workspace-write keeps it to its checkout and the reports folder. A reviewer never asks: what its hooks start
    // outside the sandbox fails and it goes on reviewing. Its hooks stay on: turning them off restarts Codex's shared server.
    runArgs({ role, home, sandboxed, config }) {
      return ["-m", this.defaultModel(config), "--sandbox", role === "executor" && !sandboxed ? "danger-full-access" : "workspace-write",
        "--ask-for-approval", role === "reviewer" ? "never" : "on-request", "--add-dir", `${home}/relevo-workflow/reports`];
    },
  },
  // Antigravity CLI: one login per macOS user (its Keychain item), so one account. No usage endpoint: its quota is
  // what Herdr reports when it runs out (quotaOf).
  agy: {
    key: "agy",
    name: "Antigravity CLI",
    short: "Antigravity",
    bin: "agy",
    apps: ["antigravity", "agy"],
    integration: "antigravity-cli",
    chip: { label: "Antigravity", letter: "A", bg: "#8aadf4", fg: "#1e2030" },
    models: ["gemini-4-neon-high", "gemini-4-carbon-high", "gemini-4-argon-high", "gemini-4-hydrogen-high", "gemini-3.8-flash-high"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    caps: { accounts: false, fork: false, quota: false, usage: false, skills: false, writer: false, runs: true },
    promptArgs: (prompt) => ["-i", prompt],
    defaultModel: () => "",
    usageDirs: () => [],
    modelArgs: (r, base) => [...base, ...(r.model ? ["--model", r.model] : []), ...(r.effort ? ["--effort", r.effort] : [])],
    // Auto mode approves edits and safe commands; anything else it asks, and Runs shows the question.
    runArgs({ home, sandboxed }) {
      return ["--mode", "auto", "--add-dir", `${home}/relevo-workflow/reports`, ...(sandboxed ? ["--sandbox"] : [])];
    },
  },
};

// The CLIs with one login each, whose account Relevo adds from what it finds on the machine.
export const singleProviders = () => Object.values(PROVIDERS).filter((p) => !p.caps.accounts);

// A full quota from what Herdr reports for an agent: "Individual quota reached. … Resets in 1h0m27s."
// Returns { resets } in epoch seconds, or null.
export function quotaOf(msg, now = Date.now() / 1000) {
  if (!/quota reached/i.test(msg ?? "")) return null;
  const m = /Resets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(msg);
  const left = m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
  return { resets: left ? Math.round(now + left) : null };
}

// An account without a provider is a Claude account, as every config before providers wrote them.
export const providerOf = (account) => PROVIDERS[account?.provider] ?? PROVIDERS.claude;

// The provider whose CLI Herdr reports for a terminal, if any.
export const providerOfApp = (app) => Object.values(PROVIDERS).find((p) => app && p.apps.includes(app)) ?? null;

// The account a terminal runs on when its app alone says it: a provider with one account.
export const accountOfApp = (app) => {
  const p = providerOfApp(app);
  return p && !p.caps.accounts ? p.key : null;
};
