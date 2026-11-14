// What an agent asks permission for, from the note the hook leaves (hooks/relevo-labels.sh), in the shape of the
// ask the screen reader finds. A note only fills in a command or plan the screen cuts, and only when all the
// screen still shows of it is the note's own end: a yes must never go to something the card didn't show.
export const ASKS_DIR = ".local/state/relevo/asks";
// The hook writes just before the agent blocks; clocks and scans leave this much room, in seconds.
const EARLY = 120;
// Less than this on screen proves too little.
const SEEN_MIN = 24;

const squash = (s) => String(s ?? "").replace(/[\s│┃]+/g, "");
// A plan is drawn from its markdown, so only its letters and digits compare.
const letters = (s) => String(s ?? "").replace(/[^\p{L}\p{N}]+/gu, "");
const rows = (s) => String(s ?? "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());

export function parseNote(raw, terminal = null) {
  try {
    const note = JSON.parse(raw ?? "");
    const whole = note && typeof note === "object" && typeof note.tool === "string" && note.input && typeof note.input === "object";
    return whole && (!terminal || note.terminal === terminal) ? note : null;
  } catch {
    return null;
  }
}

// The ask a note holds, or null. visible: the lines of the request the screen still shows, its end;
// since: when the agent began to wait, in seconds; plan: the screen asks to approve a plan.
export function noteAsk(note, visible, { since = null, plan = false } = {}) {
  if (!note || !Number.isFinite(note.at) || (since && note.at < since - EARLY)) return null;
  const isPlan = note.tool === "ExitPlanMode";
  if (isPlan !== plan || (!isPlan && note.tool !== "Bash")) return null;
  const text = isPlan ? note.input.plan : note.input.command, same = isPlan ? letters : squash;
  const seen = same((visible ?? []).join("\n")), body = rows(text);
  if (typeof text !== "string" || !body.length || seen.length < SEEN_MIN || !same(text).endsWith(seen)) return null;
  return { title: isPlan ? "Plan" : "Bash command", about: isPlan ? "" : String(note.input.description ?? ""), body, cut: false };
}
