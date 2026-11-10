// Agent text is untrusted: keep its formatting, but no raw HTML, no remote images and no live links.
export function agentMarkdown(text) {
  return String(text ?? "")
    .replace(/<[^>\n]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt) => alt)
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, label, url) => `${label} (${url})`);
}
