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
    models: ["opus", "sonnet", "haiku"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    // accounts: several logins side by side; fork: resume a copy of another account's conversation;
    // writer: offered first to write a run, so another provider reviews it.
    caps: { accounts: true, fork: true, quota: true, usage: true, skills: true, writer: false },
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
    // Its model is config's RUN_CODEX_MODEL: no list to pick from.
    models: [],
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
    caps: { accounts: false, fork: false, quota: true, usage: true, skills: false, writer: true },
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
};

// An account without a provider is a Claude account, as every config before providers wrote them.
export const providerOf = (account) => PROVIDERS[account?.provider] ?? PROVIDERS.claude;

// The provider whose CLI Herdr reports for a terminal, if any.
export const providerOfApp = (app) => Object.values(PROVIDERS).find((p) => app && p.apps.includes(app)) ?? null;

// The account a terminal runs on when its app alone says it: a provider with one account.
export const accountOfApp = (app) => {
  const p = providerOfApp(app);
  return p && !p.caps.accounts ? p.key : null;
};
