// What a waiting agent is asking, read from the bottom of its screen: the question, its numbered choices,
// whether they are checkboxes, where the cursor is and where a Submit item sits.
const OPTION = /^([❯›>]\s*)?(\d)\.\s+(.+?)\s*$/;
const SUBMIT = /^([❯›>]\s*)?(Submit|Submit answers)$/i;
const BOX = /^\[([ xX✔✓✗])?\]\s*/;
const FRAME = /^[│┃╭╮╰╯─━┌┐└┘|\s]+|[│┃╭╮╰╯─━┌┐└┘|\s]+$/g;
// Lines between two choices that still belong to the menu: a description, a blank, a separator, Submit.
const MAX_GAP = 4;

export function readPrompt(screen) {
  const lines = (screen ?? "").split("\n").map((l) => l.replace(FRAME, "")).slice(-60);
  const none = { question: lastLines(lines, 2), options: [], multi: false, submit: null, cursor: null };
  let last = -1;
  for (let i = lines.length - 1; i >= 0 && last < 0; i--) if (OPTION.test(lines[i])) last = i;
  if (last < 0) return none;
  // Walk up from the last choice to choice 1.
  const found = [{ i: last, n: Number(OPTION.exec(lines[last])[2]) }];
  let gap = 0;
  for (let i = last - 1; i >= 0 && found[0].n > 1 && gap <= MAX_GAP; i--) {
    const m = OPTION.exec(lines[i]);
    if (!m) {
      gap++;
      continue;
    }
    if (Number(m[2]) !== found[0].n - 1) break;
    found.unshift({ i, n: Number(m[2]) });
    gap = 0;
  }
  if (found[0].n !== 1) return none;
  let submit = null, cursor = null;
  const options = found.map(({ i, n }, k) => {
    // A preview drawn beside the choices shares their lines; it starts after a wide gap with a box edge.
    const [, mark, , full] = OPTION.exec(lines[i]);
    const raw = full.replace(/\s{3,}[┌│└╭╰].*$/, "");
    if (mark) cursor = n;
    const box = BOX.exec(raw);
    const next = found[k + 1]?.i ?? Math.min(lines.length, i + 1 + MAX_GAP);
    const detail = [];
    for (const l of lines.slice(i + 1, next).map((x) => x.trim()).filter(Boolean)) {
      const s = SUBMIT.exec(l);
      if (s) {
        submit = { after: n };
        if (s[1]) cursor = "submit";
      } else if (!OPTION.test(l)) detail.push(l);
    }
    const option = { n, label: box ? raw.slice(box[0].length) : raw, detail: k + 1 < found.length ? detail.join(" ") : "" };
    if (box) option.checked = Boolean(box[1] && box[1] !== " ");
    return option;
  });
  const multi = options.some((o) => "checked" in o);
  return { question: questionAbove(lines, found[0].i), options, multi, submit, cursor, summary: summaryAbove(lines, found[0].i) };
}

// The keys that move the cursor onto Submit and press it.
export function submitKeys(prompt) {
  if (!prompt?.submit) return null;
  const after = prompt.submit.after, at = prompt.cursor ?? 1;
  const moves = at === "submit" ? [] : at <= after ? Array(after - at + 1).fill("down") : Array(at - after).fill("up");
  return [...moves, "enter"];
}

// The question's own lines: not the tab strip of a multi-question form ("← ☒ CI gates ✔ Submit →").
const lastLines = (lines, n) => lines.filter((l) => l.trim() && !/^←.*→$/.test(l.trim())).slice(-n).join("\n");

// The paragraph right above the choices, at most 2 lines: it ends at a blank, the input prompt or a tab strip.
function questionAbove(lines, first) {
  const out = [];
  let i = first - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  for (; i >= 0 && out.length < 2; i--) {
    const l = lines[i].trim();
    if (!l || /^[❯›>]\s/.test(l) || /^←.*→$/.test(l) || /^[☐☒]\s/.test(l)) break;
    out.unshift(l);
  }
  return out.join("\n");
}

// A multi-question form's last step lists each question with its answer ("● question" then "→ answer")
// under "Review your answers"; the card shows it before Submit answers.
function summaryAbove(lines, first) {
  let start = -1;
  for (let i = first - 1; i >= 0 && start < 0; i--) if (/^review your answers$/i.test(lines[i].trim())) start = i;
  if (start < 0) return [];
  const out = [];
  for (const raw of lines.slice(start + 1, first)) {
    const l = raw.trim();
    if (/^●\s*/.test(l)) out.push({ question: l.replace(/^●\s*/, ""), answer: "" });
    else if (/^→\s*/.test(l) && out.length) out.at(-1).answer = l.replace(/^→\s*/, "");
  }
  return out;
}

// The free-text choice keeps the number it had as "Type something" once its label becomes what was typed.
// Claude puts it last before Submit in a multiple choice, and just before "Chat about this" in a single one.
export function freeOption(prompt, before = null) {
  const named = prompt.options.find((o) => /^type something/i.test(o.label))?.n;
  if (named) return named;
  if (before) return before;
  if (prompt.submit) return prompt.submit.after;
  const last = prompt.options.at(-1);
  return last && /^chat about this/i.test(last.label) && last.n > 1 ? last.n - 1 : null;
}

// The arrow presses from the cursor to choice `n`; Submit sits in the list right after `submit.after`.
export function moveKeys(prompt, n) {
  const order = prompt.options.flatMap((o) => (prompt.submit?.after === o.n ? [o.n, "submit"] : [o.n]));
  const from = order.indexOf(prompt.cursor ?? 1), to = order.indexOf(n);
  if (from < 0 || to < 0) return [];
  return Array(Math.abs(to - from)).fill(to > from ? "down" : "up");
}
