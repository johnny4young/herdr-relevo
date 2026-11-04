// What a waiting agent is asking, read from the bottom of its screen: the question, its numbered choices,
// whether they are checkboxes, where the cursor is and where a Submit item sits.
const OPTION = /^([❯›>]\s*)?(\d+)\.\s+(.+?)\s*$/;
const SUBMIT = /^([❯›>]\s*)?(Submit|Submit answers)$/i;
const BOX = /^\[([ xX✔✓✗])?\]\s*/;
const FRAME = /^[│┃╭╮╰╯─━┌┐└┘|\s]+|[│┃╭╮╰╯─━┌┐└┘|\s]+$/g;
// Lines between two choices that still belong to the menu: a description, a blank, a separator, Submit.
const MAX_GAP = 4;
// A dialog's top edge is a whole solid line at the margin; a command's lines are indented and a diff is fenced with ╌.
const EDGE = /^[╭┌─━][─━]{2,}[╮┐]?\s*$/;
const PREVIEW = /\s{3,}[┌│└╭╰].*$/;
// A list with no cursor this far above the bottom is old output.
const TAIL = 10;
// Output that moves on its own above a dialog: spinners, timers and tool results.
const STATUS = /^\s*[●⏺•⎿✻✶✢✳✽∗·⠀-⣿]/;
// Claude fences a permission's command, a diff or a plan with this rule.
const FENCE = /^╌{3,}$/;
const INPUT = /^[❯›>]$/;
const NOISE = /^(Tip:|[▔▁]+$|[☐☒✔←])/;
// A dialog that wants a yes to something it didn't show.
const asksBlind = (question, options) => !options.some((o) => /^(type something|chat about this)/i.test(o.label))
  && (/^(do you want|would you like)\b.*\?$/im.test(question) || options.some((o) => /^(yes, proceed|no, and tell)\b/i.test(o.label)));

export function readPrompt(screen) {
  const lines = (screen ?? "").split("\n").map((l) => l.replace(FRAME, "")).slice(-60);
  const none = { question: "", options: [], multi: false, submit: null, cursor: null, dialog: "" };
  let last = -1;
  for (let i = lines.length - 1; i >= 0 && last < 0; i--) if (OPTION.test(lines[i])) last = i;
  const footerless = () => lastLines(aboveInput(lines), 2);
  const noList = () => (unnumberedMenu(screen)
    ? { ...none, question: footerless(), unparsed: true }
    : { ...none, question: lastMessage(screen) || footerless() });
  if (last < 0) return noList();
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
  const marked = found.some(({ i }) => OPTION.exec(lines[i])[1]);
  if (!marked && lines.slice(last + 1).filter((l) => l.trim()).length > TAIL) return noList();
  const cantRead = { ...none, question: footerless(), unparsed: true };
  if (found[0].n !== 1 || found.at(-1).n > 9) return cantRead;
  let submit = null, cursor = null;
  const options = found.map(({ i, n }, k) => {
    // A preview drawn beside the choices shares their lines; it starts after a wide gap with a box edge.
    const [, mark, , full] = OPTION.exec(lines[i]);
    const raw = full.replace(PREVIEW, "");
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
  // Without a cursor these are a numbered list, or a menu whose cursor is on a row that isn't read.
  if (cursor === null) return cantRead;
  const multi = options.some((o) => "checked" in o);
  const preview = previewBeside(screen);
  const question = questionAbove(lines, found[0].i), ask = askAbove(screen, found[0].i, question);
  if (ask?.ask.cut ? !/\bplan\b/i.test(question) : !ask && asksBlind(question, options)) {
    return { ...cantRead, ask: ask?.ask ?? null, question: "Can't read all of what this asks. Open the agent." };
  }
  return {
    question: ask?.question ?? question, ask: ask?.ask ?? null, options, multi, submit, cursor, preview,
    summary: summaryAbove(lines, found[0].i),
    dialog: dialogWords(screen, found[0].i, last),
    above: aboveEdge(screen, found[0].i),
  };
}

// What a permission or a plan is about, as the card must show it before a yes: title, a line about it and
// its command, diff or plan. A command can hold any text, so when in doubt this shows more, never less.
function askAbove(screen, first, question) {
  const all = (screen ?? "").split("\n"), at = Math.max(0, all.length - 60), start = first + at;
  const text = all.map((l) => l.replace(FRAME, ""));
  return fencedAsk(all, text, start) ?? codexAsk(all, text, start) ?? unfencedAsk(all, text, start, question);
}

// A command's own line: only the dialog's gutter goes, so a trailing | stays.
const bodyLine = (raw) => raw.trim().replace(/^[│┃]\s?/, "").replace(/\s*[│┃]$/, "");

// A fence inside the command looks like Claude's, so the block runs from the topmost one.
function fencedAsk(all, text, start) {
  // At most the question's few lines between the fence and the choices; a tall window pads with blanks.
  let bottom = start - 1, words = 0;
  while (bottom >= 0 && !FENCE.test(text[bottom]) && (words += text[bottom].trim() ? 1 : 0) <= 3) bottom--;
  if (bottom < 0 || !FENCE.test(text[bottom])) return null;
  const top = text.slice(0, bottom).findIndex((l) => FENCE.test(l));
  const body = all.slice(top + 1, bottom).map(bodyLine).filter(Boolean);
  const head = [];
  for (let i = top - 1; i >= 0 && text[i].trim(); i--) if (!NOISE.test(text[i]) && !STATUS.test(text[i])) head.unshift(text[i]);
  return { ask: { title: head[0] ?? "", about: head.slice(1).join(" · "), body, cut: top < 0 } };
}

// Codex draws no edge or fence: "Would you like to run…", Reason: …, then "$ " and the command.
function codexAsk(all, text, start) {
  let top = start - 1;
  // An agent's own line above means any such dialog is an old one.
  while (top >= 0 && start - top <= 40 && !STATUS.test(text[top]) && !/^Would you like to run\b/.test(text[top])) top--;
  if (top < 0 || start - top > 40 || STATUS.test(text[top])) return null;
  const from = text.slice(top + 1, start).findIndex((l) => l.startsWith("$ ")) + top + 1;
  if (from === top) return null;
  const about = text.slice(top + 1, from).find((l) => l.startsWith("Reason:"))?.replace(/^Reason:\s*/, "") ?? "";
  const body = all.slice(from, start).map(bodyLine).filter(Boolean);
  body[0] = body[0].replace(/^\$\s*/, "");
  return { question: text[top], ask: { title: "", about, body } };
}

// Older dialogs: what sits between the edge and the question.
function unfencedAsk(all, text, start, question) {
  const top = edgeAbove(all, start);
  if (top === 0) return null;
  let end = start, left = (question ?? "").split("\n").filter(Boolean).length;
  while (end > top && (left > 0 || !text[end - 1].trim())) if (text[--end].trim()) left--;
  const rest = all.slice(top, end).map(bodyLine).filter(Boolean);
  while (rest.length && NOISE.test(rest[0])) rest.shift();
  return rest.length ? { ask: { title: rest[0], about: "", body: rest.slice(1) } } : null;
}

// The dialog from its top edge to its last choice, without what the cursor changes: a permission's command can
// sit far above the question. With no edge it takes the whole screen, so a change there refuses rather than passes.
function edgeAbove(raw, start) {
  let top = start;
  while (top > 0 && !EDGE.test(raw[top - 1])) top--;
  return top;
}

// A rule drawn inside a dialog looks like its edge, so what's above it counts too.
function aboveEdge(screen, first) {
  const raw = (screen ?? "").split("\n"), top = edgeAbove(raw, first + Math.max(0, raw.length - 60));
  return raw.slice(0, Math.max(0, top - 1)).filter((l) => !STATUS.test(l)).map((l) => l.trim()).join("\n");
}

// A cursor with a sibling row lined up under it. A cursor alone is an old message or an input prompt.
function unnumberedMenu(screen) {
  const rows = (screen ?? "").split("\n").map((l) => l.replace(/^\s*[│┃]/, "")).filter((l) => l.trim()).slice(-TAIL);
  return rows.some((l, i) => {
    const m = /^(\s*)[❯›>]\s+\S/.exec(l);
    return Boolean(m && rows[i + 1]?.startsWith(`${m[1]}  `));
  });
}

function dialogWords(screen, first, last) {
  const raw = (screen ?? "").split("\n"), at = Math.max(0, raw.length - 60), start = first + at;
  const top = edgeAbove(raw, start);
  const framed = /^\s*[│┃]/.test(raw[start]);
  const row = (l) => (framed ? l.replace(/^\s*[│┃]/, "") : l).replace(PREVIEW, "");
  const clean = (l) => l.replace(FRAME, "").replace(/^[❯›>]\s*/, "").replace(/^(\d\.\s+)\[[^\]]?\]\s*/, "$1");
  return [...raw.slice(top, start), ...raw.slice(start, last + at + 1).map(row)].map(clean).filter(Boolean).join("\n");
}

// Still the dialog the card came from, wherever the cursor is and whatever the boxes say.
export const samePrompt = (seen, now) => Boolean(seen.dialog) && seen.dialog === now.dialog
  && (seen.above ?? "") === (now.above ?? "")
  && Boolean(seen.submit) === Boolean(now.submit)
  && seen.options.length === now.options.length
  && seen.options.every((o, i) => o.label === now.options[i].label);

// The same choices, apart from the one whose label an answer just replaced.
export const sameChoicesBut = (n, seen, now) => seen.options.length === now.options.length
  && seen.options.every((o, i) => o.n === n || o.label === now.options[i].label);

// The keys that move the cursor onto Submit and press it.
export function submitKeys(prompt) {
  if (!prompt?.submit) return null;
  const after = prompt.submit.after, at = prompt.cursor ?? 1;
  const moves = at === "submit" ? [] : at <= after ? Array(after - at + 1).fill("down") : Array(at - after).fill("up");
  return [...moves, "enter"];
}

// What's above the input box: below it sit the mode and the status line.
const aboveInput = (lines) => {
  const i = lines.findLastIndex((l) => INPUT.test(l.trim()));
  return (i < 0 ? lines : lines.slice(0, i)).filter((l) => !STATUS.test(l));
};

// The question's own lines: not the tab strip of a multi-question form ("← ☒ CI gates ✔ Submit →").
const lastLines = (lines, n) => lines.filter((l) => l.trim() && !/^←.*→$/.test(l.trim())).slice(-n).join("\n");

// The paragraph right above the choices, at most 2 lines: it ends at a blank, the input prompt or a tab strip.
function questionAbove(lines, first) {
  const out = [];
  let i = first - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  for (; i >= 0 && out.length < 2; i--) {
    const l = lines[i].trim();
    if (!l || FENCE.test(l) || /^[❯›>]\s/.test(l) || /^←.*→$/.test(l) || /^[☐☒]\s/.test(l)) break;
    out.unshift(l);
  }
  return out.join("\n");
}

// The preview box drawn beside the choices shows the choice under the cursor; its inner text, or "".
function previewBeside(screen) {
  const raw = (screen ?? "").split("\n").slice(-40);
  const top = raw.findIndex((l) => /\d\.\s.*\s{3,}┌─+┐\s*$/.test(l));
  if (top < 0) return "";
  const out = [];
  for (const l of raw.slice(top + 1)) {
    if (/└─+┘\s*$/.test(l)) break;
    const m = /│(.*)│\s*$/.exec(l);
    if (m) out.push(m[1].trim());
  }
  while (out.length && !out.at(-1)) out.pop();
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

// The agent's last words on screen: its last "⏺"/"•" line that isn't a tool call ("⏺ Bash(…)") or hook noise.
export function lastMessage(screen) {
  const lines = (screen ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*[⏺•]\s+(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    const text = m[1];
    if (/^[A-Z][A-Za-z]*\(/.test(text) || /hook was skipped|^User (answered|declined)/.test(text)) continue;
    return text;
  }
  return "";
}
