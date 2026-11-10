// Agent text is untrusted: keep its formatting, but no raw HTML and no image syntax at all,
// so nothing loads by itself. Links stay text-only; the view also ignores link clicks.
const MAX_PASSES = 8, MAX_LENGTH = 20000;
let lastInput = null, lastOutput = "";

export function agentMarkdown(text) {
  const input = String(text ?? "").slice(0, MAX_LENGTH);
  if (input === lastInput) return lastOutput;
  let out = input, previous, passes = 0;
  do {
    previous = out;
    out = out.replace(/<[^<>]*>/g, "")
      .replace(/^[ >*+\-\d.]*\[[^\]]+\]:.*$/gm, "")
      .replace(/!\[([^\[\]]*)\](?:\([^()]*\)|\[[^\[\]]*\])?/g, (_m, alt) => alt)
      .replace(/!(?=\s*\[)/g, "")
      .replace(/\[([^\[\]]+)\]\(\s*([^)\s]+)[^)]*\)/g, (_m, label, url) => `${label} (${url})`)
      .replace(/\[([^\[\]]+)\]\[[^\[\]]*\]/g, (_m, label) => label);
  } while (out !== previous && ++passes < MAX_PASSES);
  // Whatever deep nesting left after the cap cannot open a tag or an image.
  lastOutput = out.replace(/<(?=[A-Za-z/!?])/g, "").replace(/!(?=\s*\[)/g, "");
  lastInput = input;
  return lastOutput;
}
