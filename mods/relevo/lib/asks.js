// What an agent asks permission for, from the notes the hook leaves (hooks/relevo-labels.sh), in the shape of the
// ask the screen reader finds. A note only fills in a command or plan the screen cuts, and only when it is the one
// request noted as this wait began and all the screen still shows of it is the note's own end: a yes must never
// go to something the card didn't show.
export const ASKS_DIR = ".local/state/relevo/asks";
// The hook runs right before the agent blocks. Two requests noted this close (in parallel, or one the hook
// missed) can't be told apart, so neither fills a card. In seconds.
const EARLY = 10;
// Less than this on screen proves too little.
const SEEN_MIN = 24;

// A plan is drawn from its markdown, so only its letters and digits compare.
const letters = (s) => String(s ?? "").replace(/[^\p{L}\p{N}]+/gu, "");
const rows = (s) => String(s ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The hook's file holds the last two requests, one per line.
export function parseNotes(raw, terminal) {
  return String(raw ?? "").split("\n").filter(Boolean).map((line) => {
    try {
      const note = JSON.parse(line);
      return note && typeof note.tool === "string" && note.input && typeof note.input === "object" && Number.isFinite(note.at) && note.terminal === terminal ? note : null;
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// The screen's lines are the command's own end, spaces and all: a line break there is the command's, or where
// the terminal wrapped it.
function endsWith(text, visible) {
  const seen = rows(visible.join("\n"));
  if (seen.join("").length < SEEN_MIN) return false;
  return new RegExp(`${seen.map(escaped).join("[ \\n]?")}$`).test(rows(text).join("\n"));
}

// The ask the notes hold for this wait, or null. visible: the lines of the request the screen still shows, its
// end; since: when the agent began to wait, by the core's clock, in seconds; plan: the screen asks to approve one.
export function noteAsk(notes, visible, { since = null, plan = false } = {}) {
  if (!Number.isFinite(since) || !Array.isArray(notes) || !Array.isArray(visible)) return null;
  const near = notes.filter((n) => n.at >= since - EARLY);
  if (near.length !== 1) return null;
  const note = near[0], isPlan = note.tool === "ExitPlanMode";
  if (isPlan !== plan || (!isPlan && note.tool !== "Bash")) return null;
  const text = isPlan ? note.input.plan : note.input.command;
  if (typeof text !== "string" || !rows(text).length) return null;
  const same = isPlan ? letters(visible.join("\n")).length >= SEEN_MIN && letters(text).endsWith(letters(visible.join("\n"))) : endsWith(text, visible);
  return same ? { title: isPlan ? "Plan" : "Bash command", about: isPlan ? "" : String(note.input.description ?? ""), body: rows(text), cut: false } : null;
}
