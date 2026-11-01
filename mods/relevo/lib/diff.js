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
