// Agent text is untrusted: keep its formatting, but no raw HTML and no image syntax at all,
// so nothing loads by itself. Links stay text-only; the view also ignores link clicks.
export function agentMarkdown(text) {
  let out = String(text ?? ""), previous;
  do {
    previous = out;
    out = out.replace(/<[^<>]*>/g, "")
      .replace(/!\[([^\[\]]*)\](?:\([^()]*\)|\[[^\[\]]*\])?/g, (_m, alt) => alt)
      .replace(/!(?=\s*\[)/g, "");
  } while (out !== previous);
  return out
    .replace(/^ {0,3}\[[^\]]+\]:.*$/gm, "")
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, label, url) => `${label} (${url})`)
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, (_m, label) => label);
}
