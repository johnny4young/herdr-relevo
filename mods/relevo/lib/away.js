// What happened while you were away: pure, so the tests can feed it a whole absence.

export const AWAY_AFTER = 10 * 60 * 1000;

// A stretch away starts when the window goes behind or the app stops ticking (the Mac slept).
export const leftAt = ({ active, now, lastTick }) => {
  if (lastTick && now - lastTick >= AWAY_AFTER) return lastTick;
  return active ? null : now;
};

const RESTING = new Set(["done", "idle"]);

// agents: [{ address, status }]; worked: addresses seen working while away; quotas: { key: { h5, d7 } }.
export function awaySummary({ since, now, agents, worked, events, quotasBefore, quotasNow, labels = {} }) {
  const finished = agents.filter((a) => worked.has(a.address) && RESTING.has(a.status)).map((a) => a.address);
  const waiting = agents.filter((a) => a.status === "blocked").map((a) => a.address);
  const seen = new Set(), prs = [];
  for (const e of events) {
    if (seen.has(e.title)) continue;
    seen.add(e.title);
    prs.push({ title: e.title, url: e.url, kind: e.kind });
  }
  const quota = [];
  for (const [key, q] of Object.entries(quotasNow ?? {})) {
    const was = quotasBefore?.[key], used = (w) => (q?.[w] && was?.[w] ? q[w].pct - was[w].pct : 0);
    const h5 = used("h5"), d7 = used("d7");
    if (h5 > 0 || d7 > 0) quota.push({ key, label: labels[key] ?? key, h5: Math.max(0, h5), d7: Math.max(0, d7) });
  }
  if (!finished.length && !waiting.length && !prs.length && !quota.length) return null;
  return { since, now, finished, waiting, prs, quota };
}

// Seconds of agent time inside [since, now] from ledger rows ({ start, end } in seconds).
export const timeWithin = (rows, since, now) =>
  rows.reduce((sum, r) => sum + Math.max(0, Math.min(r.end, now) - Math.max(r.start, since)), 0);
