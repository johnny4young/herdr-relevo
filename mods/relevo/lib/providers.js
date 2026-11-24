// What each agent CLI can do, so features ask a provider instead of comparing account keys. Pure.

export const PROVIDERS = {
  claude: {
    key: "claude",
    name: "Claude Code",
    // What Herdr reports as the terminal's agent or app.
    apps: ["claude", "claude-code"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    // accounts: several logins side by side; fork: resume a copy of another account's conversation.
    caps: { accounts: true, fork: true, quota: true, usage: true, skills: true },
    modelArgs: (r, base) => [...base, ...(r.model ? ["--model", r.model] : []), ...(r.effort ? ["--effort", r.effort] : [])],
  },
  codex: {
    key: "codex",
    name: "Codex",
    apps: ["codex"],
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
    caps: { accounts: false, fork: false, quota: true, usage: true, skills: false },
    // Codex takes its model with -m, already in a run's base flags, and its effort as a config override.
    modelArgs(r, base) {
      const args = [...base], at = args.indexOf("-m");
      if (r.model && at >= 0) args[at + 1] = r.model;
      return r.effort ? [...args, "-c", `model_reasoning_effort="${r.effort}"`] : args;
    },
  },
};

// An account without a provider is a Claude account, as every config before providers wrote them.
export const providerOf = (account) => PROVIDERS[account?.provider] ?? PROVIDERS.claude;

// The provider whose CLI Herdr reports for a terminal, if any.
export const providerOfApp = (app) => Object.values(PROVIDERS).find((p) => app && p.apps.includes(app)) ?? null;
