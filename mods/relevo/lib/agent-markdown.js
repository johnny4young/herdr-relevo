// Agent text is untrusted: keep its formatting, but no raw HTML, no images and no live links.
export function agentMarkdown(text) {
  return String(text ?? "")
    .replace(/^ {0,3}\[[^\]]+\]:.*$/gm, "")
    .replace(/<[^>]*>/gs, "")
    .replace(/!\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])?/g, (_m, alt) => alt)
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, label, url) => `${label} (${url})`)
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, (_m, label) => label);
}
