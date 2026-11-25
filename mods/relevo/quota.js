import { exec, home, readTextFile } from "herdr";
import { allAccounts } from "./accounts.js";
import { agyUsage, providerOf } from "./lib/providers.js";
import { shellArgv } from "./lib/session-env.js";

// Asks each provider's usage endpoint with that account's own login. Expired tokens are
// skipped, never refreshed: refreshing would rotate the login Claude Code or Codex keep.

const epoch = (v) => (v == null || typeof v === "number" ? v : Date.parse(v) / 1000);

async function getJSON(url, headers) {
  const r = await fetch(url, { headers: { "User-Agent": "herdr-relevo/1.0", ...headers } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Claude Code names each profile's Keychain item after a hash of its config dir.
async function claudeToken(dir) {
  const path = `${home()}/${dir}`;
  const hash = (await exec("sh", ["-c", 'printf %s "$1" | shasum -a 256', "sh", path])).stdout.slice(0, 8);
  const r = await exec("security", ["find-generic-password", "-s", `Claude Code-credentials-${hash}`, "-w"]);
  if (r.code !== 0) throw new Error("no Keychain item");
  const oauth = JSON.parse(r.stdout).claudeAiOauth ?? {};
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) throw new Error("token expired");
  return oauth.accessToken;
}

async function claude(dir) {
  const data = await getJSON("https://api.anthropic.com/api/oauth/usage", {
    Authorization: `Bearer ${await claudeToken(dir)}`,
    "anthropic-beta": "oauth-2025-04-20",
  });
  const out = {};
  for (const name of ["five_hour", "seven_day"]) {
    const w = data[name];
    if (w?.utilization != null) out[name] = { used_percentage: w.utilization, resets_at: epoch(w.resets_at) };
  }
  return out;
}

async function codex() {
  const tokens = JSON.parse(await readTextFile(`${home()}/.codex/auth.json`) ?? "{}").tokens ?? {};
  const headers = { Authorization: `Bearer ${tokens.access_token}` };
  if (tokens.account_id) headers["ChatGPT-Account-Id"] = tokens.account_id;
  const rate = (await getJSON("https://chatgpt.com/backend-api/wham/usage", headers)).rate_limit ?? {};
  const out = {};
  for (const w of [rate.primary_window, rate.secondary_window]) {
    if (w?.used_percent == null) continue;
    out[(w.limit_window_seconds ?? 0) <= 18000 ? "five_hour" : "seven_day"] = {
      used_percentage: w.used_percent,
      resets_at: epoch(w.reset_at),
      ...(w.limit_window_seconds ? { window_seconds: w.limit_window_seconds } : {}),
    };
  }
  return out;
}

// agy's own usage report, in the login shell where it is installed: in a temp folder, without updating itself, and
// with `open` and BROWSER failing so a lost login never opens Google's sign-in from the background. 90 s at most.
const AGY_USAGE = 'd=$(mktemp -d) || exit 1; printf "#!/bin/sh\\nexit 1\\n" > "$d/open"; chmod +x "$d/open"; cp "$d/open" "$d/xdg-open"; '
  + 'cd "$d" && { PATH="$d:$PATH" BROWSER="$d/open" AGY_CLI_DISABLE_AUTO_UPDATE=true agy -p /usage --output-format json & p=$!; '
  + '(sleep 90; kill $p) >/dev/null 2>&1 & w=$!; wait $p; s=$?; kill $w 2>/dev/null; }; cd /; rm -f "$d/open" "$d/xdg-open"; rmdir "$d"; exit $s';
// Each report starts an agy process, so one every five minutes is enough.
const AGY_EVERY = 300;
let agyLast = null;

async function agy() {
  const now = Date.now() / 1000;
  if (agyLast && now - agyLast.at < AGY_EVERY) return agyLast.limits;
  const settings = JSON.parse(await readTextFile(`${home()}/.gemini/antigravity-cli/settings.json`).catch(() => null) ?? "{}");
  const [cmd, ...args] = shellArgv(AGY_USAGE);
  const r = await exec(cmd, args);
  const limits = r.code === 0 ? agyUsage(r.stdout, settings.model ?? "") : null;
  if (!limits) throw new Error(r.code === 0 ? "no usage report" : `agy exited ${r.code}`);
  agyLast = { at: now, limits };
  return limits;
}

// How each provider asks its usage endpoint.
const ASK = { claude: (a) => claude(a.claudeDir), codex: () => codex(), agy: () => agy() };

// { account: { updated, rate_limits } | { error } }, one account failing leaves the others.
export async function collectQuotas() {
  const jobs = Object.fromEntries(allAccounts().filter((a) => ASK[providerOf(a).key])
    .map((a) => [a.key, () => ASK[providerOf(a).key](a)]));
  const out = {};
  for (const [key, job] of Object.entries(jobs)) {
    try {
      out[key] = { updated: Math.floor(Date.now() / 1000), rate_limits: await job() };
    } catch (e) {
      out[key] = { error: String(e?.message ?? e).slice(0, 80) };
    }
  }
  return out;
}
