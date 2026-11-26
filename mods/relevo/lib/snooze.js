// Temporal snooze for Reviews/Now items: hides a row until a deadline, CI green, or new activity. Pure.

export const SNOOZE_PRESETS = [
  { key: "30m", label: "30 minutes", ms: 30 * 60e3 },
  { key: "2h", label: "2 hours", ms: 2 * 3600e3 },
  { key: "tomorrow", label: "Tomorrow 9:00" },
  { key: "ci", label: "Until CI green", untilCi: true },
];

export function tomorrowMorning(now = Date.now()) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

export function snoozeUntil(presetKey, { since = 0, label = "" } = {}, now = Date.now()) {
  const preset = SNOOZE_PRESETS.find((p) => p.key === presetKey) ?? SNOOZE_PRESETS[0];
  const untilMs = preset.key === "tomorrow" ? tomorrowMorning(now)
    : preset.untilCi ? now + 24 * 3600e3
      : now + (preset.ms ?? 30 * 60e3);
  return {
    until: Math.round(untilMs / 1000),
    kind: preset.key,
    untilCi: Boolean(preset.untilCi),
    since: Number.isFinite(since) ? since : 0,
    label,
  };
}

export function isSnoozed(entry, { ci = null, updatedAt = 0 } = {}, now = Date.now() / 1000) {
  if (!entry || !Number.isFinite(entry.until) || entry.until <= now) return false;
  if (entry.untilCi && ci === "SUCCESS") return false;
  if (entry.since && updatedAt && updatedAt > entry.since) return false;
  return true;
}

export function pruneSnoozed(map, now = Date.now() / 1000) {
  const next = {};
  for (const [id, entry] of Object.entries(map ?? {})) {
    if (entry && Number.isFinite(entry.until) && entry.until > now) next[id] = entry;
  }
  return next;
}

// Seconds until the first snooze runs out, or null when none is left.
export function nextWake(map, now = Date.now() / 1000) {
  const ends = Object.values(pruneSnoozed(map, now)).map((e) => e.until - now);
  return ends.length ? Math.min(...ends) : null;
}

export function snoozeLabel(entry, now = Date.now() / 1000) {
  if (!entry) return "";
  if (entry.untilCi) return "until CI green";
  const left = Math.max(0, Math.round((entry.until - now) / 60));
  if (left < 60) return `for ${Math.max(1, left)}m`;
  if (left < 24 * 60) return `for ${Math.round(left / 60)}h`;
  return "until tomorrow";
}
