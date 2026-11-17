// Syntax colors for diff lines. The kit highlights only whole documents, so lines are split here into
// [kind, text] runs; kinds match the Files editor's syntax names so both read the same.

const words = (s) => new Set(s.split(" "));
const C_FAMILY = "break case continue default do else for if return switch while";
const KEYWORDS = {
  js: words(`${C_FAMILY} as async await catch class const debugger delete export extends finally from function get implements import in instanceof interface let new of private protected public readonly set static super throw try type typeof var void with yield enum declare namespace keyof satisfies`),
  go: words(`${C_FAMILY} chan const defer fallthrough func go goto import interface map package range select struct type var`),
  swift: words(`${C_FAMILY} actor as associatedtype async await catch class defer deinit didSet enum extension fileprivate final func guard import in init inout internal is let mutating open operator override private protocol public repeat rethrows some static struct subscript throw throws try typealias var weak where willSet`),
  rust: words(`${C_FAMILY} as async await const crate dyn enum extern fn impl in let loop match mod move mut pub ref static struct trait type unsafe use where`),
  py: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case"),
  sh: words("if then else elif fi for while until do done case esac in function return local export readonly declare set unset shift exit source alias trap"),
  c: words(`${C_FAMILY} abstract boolean byte char class const double enum extends final float goto implements import instanceof int interface long native new package private protected public short static struct super synchronized throw throws transient try catch finally typedef union unsigned var void volatile fun val when object data sealed override`),
  css: words("important media import supports keyframes font-face"),
  json: words(""),
  yaml: words(""),
  sql: words("select from where and or not insert into values update set delete create table alter drop index join left right inner outer on as group by order having limit offset union distinct case when then else end primary key references default null"),
};
const CONSTANTS = words("true false null undefined nil None True False NaN Infinity this self Self super iota");

const FAMILY = {
  js: "js", jsx: "js", ts: "js", tsx: "js", mjs: "js", cjs: "js", mts: "js", cts: "js",
  go: "go", swift: "swift", rs: "rust", py: "py",
  sh: "sh", bash: "sh", zsh: "sh", fish: "sh",
  c: "c", h: "c", cc: "c", cpp: "c", hpp: "c", m: "c", java: "c", kt: "c", kts: "c", cs: "c",
  css: "css", scss: "css", less: "css",
  json: "json", jsonc: "json", yml: "yaml", yaml: "yaml", toml: "yaml",
  sql: "sql",
};
const HASH_COMMENTS = new Set(["py", "sh", "yaml"]);
const SLASH_COMMENTS = new Set(["js", "go", "swift", "rust", "c", "css", "json"]);
// Past this a line stays plain: minified files would cost more than they show.
const LONG = 400;

export function languageFor(path) {
  const name = String(path ?? "").split("/").pop() ?? "";
  if (/^(Dockerfile|Makefile)$|^\.(zshrc|bashrc|profile|env)/.test(name)) return "sh";
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return FAMILY[ext] ?? null;
}

const STRING = String.raw`"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|\`(?:\\.|[^\`\\])*\`?`;
const NUMBER = String.raw`\b0x[\da-fA-F_]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b`;
const WORD = String.raw`[A-Za-z_$][\w$]*`;
const scanners = new Map();
// The leftmost match wins, so a comment marker inside a string stays part of the string.
function scanner(lang) {
  if (!scanners.has(lang)) {
    const line = HASH_COMMENTS.has(lang) ? String.raw`(?:^|\s)#.*` : lang === "sql" ? "--.*" : SLASH_COMMENTS.has(lang) && lang !== "css" ? "//.*" : null;
    const block = SLASH_COMMENTS.has(lang) ? String.raw`/\*` : null;
    // Single quotes are apostrophes in shell comments and YAML text often enough; they still read as strings.
    scanners.set(lang, new RegExp(`(${block ?? "(?!)"})|(${line ?? "(?!)"})|(${STRING})|(${NUMBER})|(${WORD})`, "g"));
  }
  return scanners.get(lang);
}

const kindOf = (word, after, lang) => (KEYWORDS[lang].has(lang === "sql" ? word.toLowerCase() : word) ? "keyword"
  : CONSTANTS.has(word) ? "constant" : after === "(" ? "function" : /^[A-Z][a-z]/.test(word) && lang !== "sh" ? "type" : null);

// One line's runs, or null to draw it plain. `state.block` carries an open /* */ comment to the next line.
export function tokenize(text, lang, state = {}) {
  if (!lang || !KEYWORDS[lang] || text.length > LONG) return null;
  const out = [];
  const push = (kind, s) => {
    if (!s) return;
    const last = out.at(-1);
    if (last && last[0] === kind) last[1] += s;
    else out.push([kind, s]);
  };
  let i = 0;
  if (state.block) {
    const end = text.indexOf("*/");
    if (end === -1) return [["comment", text]];
    push("comment", text.slice(0, end + 2));
    i = end + 2;
    state.block = false;
  }
  const re = scanner(lang);
  re.lastIndex = i;
  let m;
  while ((m = re.exec(text))) {
    push(null, text.slice(i, m.index));
    const [whole, block, line, str, num, word] = m;
    if (block) {
      const end = text.indexOf("*/", m.index + 2);
      if (end === -1) { push("comment", text.slice(m.index)); state.block = true; return out; }
      push("comment", text.slice(m.index, end + 2));
      i = re.lastIndex = end + 2;
      continue;
    }
    if (line) {
      const lead = line.match(/^\s*/)[0];
      push(null, lead);
      push("comment", line.slice(lead.length));
      return out;
    }
    if (str) push("string", str);
    else if (num) push("number", num);
    else if (word) push(kindOf(word, text[m.index + whole.length], lang), word);
    else if (!whole) re.lastIndex++;
    i = m.index + whole.length;
  }
  push(null, text.slice(i));
  return out;
}

// Tokens for every row of a diff; a hunk header starts the comment state over.
export function highlightRows(rows, lang) {
  if (!lang) return rows;
  let state = {};
  for (const r of rows) {
    if (r.kind === "@") { state = {}; continue; }
    r.tokens = tokenize(r.text, lang, state);
  }
  return rows;
}
