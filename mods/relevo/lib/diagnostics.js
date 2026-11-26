// Pure health summary for the Settings Diagnostics panel.

export function summarizeDiagnostics({ git, ghAuth, hc, hook, state, quotas, accounts = [] }) {
  const rows = [];
  const gitVer = /\d+\.\d+\.\d+/.exec(git?.stdout ?? "")?.[0];
  rows.push({
    id: "git",
    label: "Git",
    status: git?.code === 0 ? "ok" : "bad",
    detail: git?.code === 0 ? (gitVer ? `git ${gitVer}` : "available") : "git not found on PATH",
  });
  const ghOk = ghAuth?.code === 0;
  const ghUser = /Logged in to [^\s]+ account ([^\s(]+)/i.exec(`${ghAuth?.stdout ?? ""}\n${ghAuth?.stderr ?? ""}`)?.[1];
  rows.push({
    id: "gh",
    label: "GitHub CLI",
    status: ghOk ? "ok" : "bad",
    detail: ghOk ? (ghUser ? `signed in as ${ghUser}` : "authenticated") : "not signed in · run gh auth login",
  });
  rows.push({
    id: "hc",
    label: "Herdr CLI (hc)",
    status: hc?.code === 0 ? "ok" : "warn",
    detail: hc?.code === 0 ? "available" : "hc not found on PATH",
  });
  if (hook) {
    rows.push({
      id: "hook",
      label: "Claude hook",
      status: hook.code === 0 ? "ok" : "warn",
      detail: hook.code === 0
        ? "installed"
        : (hook.stdout || hook.stderr || "missing or outdated").trim().split("\n")[0].slice(0, 80),
    });
  }
  const tasks = Array.isArray(state?.tasks) ? state.tasks : null;
  const active = tasks ? tasks.filter((t) => !["accepted", "cancelled"].includes(t.state)).length : 0;
  rows.push({
    id: "runs",
    label: "Runs runtime",
    status: tasks ? "ok" : "warn",
    detail: tasks
      ? `${state.engine?.enabled === false ? "paused" : "ready"} · ${active} open / ${tasks.length} total`
      : "no state yet",
  });
  const total = accounts.length;
  const live = accounts.filter((a) => Boolean(quotas?.[a.key])).length;
  rows.push({
    id: "quotas",
    label: "Account quotas",
    status: !total ? "warn" : live === total ? "ok" : live > 0 ? "warn" : "bad",
    detail: total ? `${live}/${total} accounts reporting` : "no active accounts",
  });
  return rows;
}
