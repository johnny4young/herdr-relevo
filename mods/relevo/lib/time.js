// Ages, durations and quota windows; pure, so the tests can run them under Node.

export const FIVE_HOURS = 5 * 3600, WEEK = 7 * 86400;

export function ago(seconds) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s <= 2 * 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const duration = (s) => (s < 3600
  ? `${Math.round(s / 60)}m`
  : `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")}m`);

export function windowOf(pct, resets, length) {
  if (pct == null) return null;
  const now = Date.now() / 1000;
  if (resets && resets < now) return { pct: 0, resets: null, pace: null };
  const pace = resets ? Math.min(1, Math.max(0, 1 - (resets - now) / length)) : null;
  return { pct: Math.round(pct), resets, pace };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n) => String(n).padStart(2, "0");

export function resetClock(w) {
  if (!w?.resets) return null;
  const d = new Date(w.resets * 1000);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? time : `${DAYS[d.getDay()]} ${time}`;
}

export function resetText(w) {
  if (!w?.resets) return w ? "No active window" : "No data yet";
  const d = new Date(w.resets * 1000), now = new Date();
  const day = d.toDateString() === now.toDateString() ? "today" : DAYS[d.getDay()];
  const s = Math.max(0, w.resets - Date.now() / 1000);
  const left = s >= 86400
    ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
    : `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
  return `Resets ${day} ${pad(d.getHours())}:${pad(d.getMinutes())} · in ${left}`;
}
