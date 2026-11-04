// Reads that write nothing under .git (index refresh, lock, fsmonitor cookie), which a folder watch would wake on.
export const GIT_READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

// Only a URL whose host is exactly github.com names a GitHub repo.
export function githubRepo(url) {
  const u = (url ?? "").trim();
  const m = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(u);
  return m?.[1] ?? null;
}

// A URL can carry a token, so what's shown never has its login. Only inside the real authority:
// in evil.example?@github.com the host is evil.example, and it must stay what's shown.
export const withoutLogin = (text) => String(text ?? "").replace(/(\w+:\/\/)[^/?#\\\s]*@/g, "$1");
