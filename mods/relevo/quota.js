import { exec, home, readTextFile } from "herdr";
import { ACCOUNTS } from "./config.js";

// Asks each provider's usage endpoint with that account's own login. Expired tokens are
// skipped, never refreshed: refreshing would rotate the login Claude Code or Codex keep.
const CLAUDE_DIRS = Object.fromEntries(ACCOUNTS.map((a) => [a.key, a.claudeDir]));

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
    };
  }
  return out;
}

// { account: { updated, rate_limits } | { error } }, one account failing leaves the others.
export async function collectQuotas() {
  const jobs = {
    ...Object.fromEntries(Object.entries(CLAUDE_DIRS).map(([key, dir]) => [key, () => claude(dir)])),
    codex,
  };
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
