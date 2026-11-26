// Old and new line numbers for each diff line, as in the Changes panel.
export function diffRows(lines) {
  let old = 0, next = 0, inHunk = false;
  return lines.map((line) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) {
      old = +m[1];
      next = +m[2];
      inHunk = true;
      return { kind: "@", text: line };
    }
    if (!inHunk) return null;
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") {
      old++;
      return { kind, number: next++, text: line.slice(1) || " " };
    }
    return null;
  }).filter(Boolean);
}

// A comment follows its line across refreshes: removed lines by old number, the rest by new.
export const lineKey = (r) => `${r.kind === "-" ? "-" : "+"}${r.number}`;

const numbered = (r) => r?.number !== undefined;

// The rows between two clicks in either order, trimmed to numbered lines at both ends; null when none is left.
export function selectRange(rows, a, b) {
  let start = Math.min(a, b), end = Math.max(a, b);
  while (start <= end && !numbered(rows[start])) start++;
  while (end >= start && !numbered(rows[end])) end--;
  return start <= end ? { start, end } : null;
}

// Single lines keep the original shape so comments saved before ranges existed still match and send.
export function lineComment(file, rows, start, end, text) {
  const first = rows[start], last = rows[end];
  const one = { file, key: lineKey(last), line: last.number, side: last.kind, code: last.text.trim(), text };
  if (start === end) return one;
  return {
    ...one, start: lineKey(first), line: first.number, side: first.kind, code: first.text.trim(),
    end: last.number, endSide: last.kind, endCode: last.text.trim(), count: end - start + 1,
  };
}

export const fileComment = (file, text) => ({ file, scope: "file", key: "file", text });

// One comment per line, range or file: saving the same target again replaces it.
export const commentId = (c) => (c.scope === "file" ? "file" : c.start ? `${c.start}..${c.key}` : c.key);

// Where a comment sits, as the pane labels it: "L5-7", "L12" or "File".
export const commentLabel = (c) => (c.scope === "file" ? "File" : `L${c.line}${c.start ? `-${c.end}` : ""}`);

// Rows covered by saved ranges of the open file, so they stay tinted after the editor closes.
export function rangeRows(rows, comments) {
  if (!comments.some((c) => c.start)) return new Set();
  const at = new Map();
  rows.forEach((r, i) => {
    if (numbered(r)) at.set(lineKey(r), i);
  });
  // Ranges can overlap, so a row is marked once however many cover it.
  const edges = new Int32Array(rows.length + 1);
  for (const c of comments) {
    const from = c.start ? at.get(c.start) : undefined, to = at.get(c.key);
    if (from === undefined || to === undefined || from > to) continue;
    edges[from]++;
    edges[to + 1]--;
  }
  const marked = new Set();
  let active = 0;
  for (let i = 0; i < rows.length; i++) {
    active += edges[i];
    if (active > 0) marked.add(i);
  }
  return marked;
}

const quote = (code) => `   > ${code.slice(0, 160)}`;

export function formatComment(c, n) {
  if (c.scope === "file") return [`${n}. ${c.file} (whole file)`, `   ${c.text}`].join("\n");
  if (!c.start) {
    return [`${n}. ${c.file}:${c.line}${c.side === "-" ? " (removed line)" : ""}`, quote(c.code), `   ${c.text}`].join("\n");
  }
  const removed = c.side === "-" && c.endSide === "-" ? " (removed lines)" : "";
  return [
    `${n}. ${c.file}:${c.line}-${c.end}${removed}`,
    quote(c.code),
    ...(c.count > 2 ? ["   > …"] : []),
    quote(c.endCode),
    `   ${c.text}`,
  ].join("\n");
}

export const reviewMessage = (comments, subject = "the uncommitted changes") =>
  `Review comments on ${subject}. Address each one, then summarize what you changed.\n\n`
  + comments.map((c, i) => formatComment(c, i + 1)).join("\n\n");

export function hunkIndices(rows) {
  const out = [];
  for (let i = 0; i < (rows?.length ?? 0); i++) if (rows[i]?.kind === "@") out.push(i);
  return out;
}

export function searchMatches(rows, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (let i = 0; i < (rows?.length ?? 0); i++) {
    if (String(rows[i]?.text ?? "").toLowerCase().includes(q)) out.push(i);
  }
  return out;
}

// Pending GitHub pull request review payload (never sets `event`, so it stays a draft for the user to edit/submit).
export function githubDraftReview(comments, inline = true) {
  const list = comments ?? [];
  if (!inline) {
    return {
      body: list.map((c, i) => formatComment(c, i + 1)).join("\n\n"),
      comments: [],
    };
  }
  const bodyParts = [], inlineComments = [];
  for (const c of list) {
    const endLine = c.start ? c.end : c.line;
    const valid = c.scope !== "file" && Number.isInteger(c.line) && c.line > 0 && Number.isInteger(endLine) && endLine > 0;
    if (!valid) {
      bodyParts.push(`**${c.file}**${c.scope === "file" ? " (file)" : ""}\n${c.text}`);
      continue;
    }
    const side = (c.start ? c.endSide : c.side) === "-" ? "LEFT" : "RIGHT";
    const entry = { path: c.file, line: endLine, side, body: c.text };
    if (c.start && c.line < endLine) {
      entry.start_line = c.line;
      entry.start_side = c.side === "-" ? "LEFT" : "RIGHT";
    }
    inlineComments.push(entry);
  }
  return {
    body: bodyParts.join("\n\n"),
    comments: inlineComments,
  };
}
