import { home, readTextFile, run, spaces, shared } from "herdr";
import { ACCOUNTS as CONFIGURED, CODEX as CODEX_ACCOUNT, FALLBACK } from "./config.js";
import { FIVE_HOURS, WEEK, windowOf } from "./lib/time.js";
import { accountFor } from "./context.js";

export const API_QUOTAS = "relevo.quota.api";

// `file` is the statusline's quota snapshot for that account.
const withFile = (a) => ({ ...a, file: `quota-${a.key}.json` });
export const ACCOUNTS = CONFIGURED.map(withFile);
export const CODEX = withFile(CODEX_ACCOUNT);

export const accountOf = (key) => [...ACCOUNTS, CODEX].find((p) => p.key === key) ?? ACCOUNTS[0];

// `args` go before the prompt as positional parameters, never into the shell text.
export function launchArgv(key, prompt, args = []) {
  const p = accountOf(key), refs = args.map((_, i) => ` "$${i + 2}"`).join("");
  return prompt ? ["zsh", "-ilc", `${p.launcher}${refs} "$1"`, "zsh", prompt, ...args] : ["zsh", "-ilc", p.launcher];
}


export function fromClaude(json) {
  const r = json?.rate_limits ?? {};
  return {
    updated: json?.updated ?? 0,
    h5: windowOf(r.five_hour?.used_percentage, r.five_hour?.resets_at, FIVE_HOURS),
    d7: windowOf(r.seven_day?.used_percentage, r.seven_day?.resets_at, WEEK),
  };
}

// The newest of the usage endpoint (shared state) and the statusline snapshot (file).
export async function loadClaudeQuotas() {
  const out = {}, api = shared(API_QUOTAS) ?? {};
  for (const p of [...ACCOUNTS, CODEX]) {
    let file = null;
    try {
      file = JSON.parse(await readTextFile(`${home()}/.cache/herdr-relevo/${p.file}`) ?? "null");
    } catch {
      file = null;
    }
    const fromApi = api[p.key]?.rate_limits ? api[p.key] : null;
    const best = [fromApi, file].filter(Boolean).sort((a, b) => b.updated - a.updated)[0];
    out[p.key] = best ? fromClaude(best) : null;
  }
  return out;
}

const full = (q) => (q?.h5?.pct >= 100 ? "5h" : q?.d7?.pct >= 100 ? "7d" : null);

// The repo's account unless it is out of quota; Team is the shared fallback.
export function pickAccount(repo, quotas) {
  const key = accountFor(repo), window = full(quotas?.[key]);
  if (!window) return { key, note: null };
  const alt = FALLBACK.find((k) => k !== key && !full(quotas?.[k]));
  return alt
    ? { key: alt, note: `${accountOf(key).label} is at 100% (${window}) — using ${accountOf(alt).label}` }
    : { key, note: null };
}



// Runs in the repo's own space (or a new one), not in whichever space is shown.
export function launchInRepo({ repo, folder, tab, account, prompt }) {
  const name = repo.split("/").pop();
  const space = spaces().find((s) => !s.machine && s.folder === folder)
    ?? spaces().find((s) => !s.machine && s.name === name);
  const argv = launchArgv(account, prompt);
  if (space) run("tab.new", { space: space.id, name: tab, folder, argv });
  else run("space.new", { name, folder, tab, argv });
}

export function chip(div, p, size = 17) {
  return div().size(size).flex_none().rounded(5).bg(p.bg).text_color(p.fg).text_size(size * 0.6).font_semibold()
    .flex().items_center().justify_center()
    .child(p.letter);
}
