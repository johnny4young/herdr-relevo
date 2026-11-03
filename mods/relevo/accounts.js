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

// The newest source that still has this window: one without it, or whose window ended, says nothing about the current one.
export function currentWindow(sources, name, now) {
  const known = sources.map((s) => s.rate_limits?.[name]).filter((w) => w?.used_percentage != null);
  return known.find((w) => !w.resets_at || w.resets_at > now) ?? known[0];
}

// The usage endpoint (shared state) and the statusline snapshot (file), window by window.
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
    const sources = [fromApi, file].filter(Boolean).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    if (!sources.length) {
      out[p.key] = null;
      continue;
    }
    const now = Date.now() / 1000;
    out[p.key] = fromClaude({
      updated: sources[0].updated,
      rate_limits: { five_hour: currentWindow(sources, "five_hour", now), seven_day: currentWindow(sources, "seven_day", now) },
    });
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

// The session id goes as a positional parameter, never into the shell text.
export const resumeArgv = (key, id) => ["zsh", "-ilc", `${accountOf(key).launcher} --resume "$1"`, "zsh", id];

// A tab in the folder's space, else in the repo's, else a new space.
export function openInFolder({ name, folder, tab, argv }) {
  const space = spaces().find((s) => !s.machine && s.folder === folder)
    ?? spaces().find((s) => !s.machine && s.name === name);
  if (space) run("tab.new", { space: space.id, name: tab, folder, argv });
  else run("space.new", { name, folder, tab, argv });
}

// Runs in the repo's own space (or a new one), not in whichever space is shown.
export function launchInRepo({ repo, folder, tab, account, prompt }) {
  openInFolder({ name: repo.split("/").pop(), folder, tab, argv: launchArgv(account, prompt) });
}

export function chip(div, p, size = 17) {
  return div().size(size).flex_none().rounded(5).bg(p.bg).text_color(p.fg).text_size(size * 0.6).font_semibold()
    .flex().items_center().justify_center()
    .child(p.letter);
}
