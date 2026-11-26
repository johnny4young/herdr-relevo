import { div, list } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, Scrollbar, TextView } from "gpui-base";
import { theme, exec, run, agents, panes, focused, props, settings, notify, shared, setShared, window } from "herdr";
import { focusedCwd } from "./panelbar.js";
import { button, checkbox, icon, tag, diffRatio, keycap, openUrl } from "./ui.js";
import { ago } from "./lib/time.js";
import { launchInRepo } from "./accounts.js";
import { accountFor } from "./context.js";
import { baseBranch, checkoutOf } from "./worktrees.js";
import { localBranch, pullRef, pullRefspec } from "./lib/prmenu.js";
import { openWorkflow } from "./workflow-window.js";
import { GIT_READ as READ } from "./lib/git.js";
import { AGENT_PRS } from "./lib/github.js";
import { diffRows, lineKey, selectRange, lineComment, fileComment, commentId, commentLabel, rangeRows, reviewMessage, hunkIndices, searchMatches, githubDraftReview } from "./lib/diff.js";
import { highlightRows, languageFor } from "./lib/highlight.js";
import { agentMarkdown } from "./lib/agent-markdown.js";

const MAX_ROWS = 4000;
// Open review panes by checkout, so a second Review focuses the first.
const OPEN = "relevo.reviews";
// Unsent comments by checkout, so closing the pane or Herdr doesn't lose them.
const NOTES = "relevo.review.notes";
// What the review showed when marked seen, by checkout or PR: { tree, at }.
const SEEN = "relevo.review.seen";
// Files marked viewed, by checkout or PR: path -> the content's hash then, so a change unmarks it.
const VIEWED = "relevo.review.viewed";
// Reviews whose marks are kept, the newest ones: every other review's marks go when one is written.
const MARKS_KEPT = 40;
const keepLatest = (all, key, mine) => {
  const { [key]: _, ...others } = all ?? {};
  return { ...Object.fromEntries(Object.entries(others).slice(-(MARKS_KEPT - 1))), [key]: mine };
};
// A short sign of a diff, so the text itself isn't kept between reads.
const signOf = (text) => {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
};
// The working tree as a git tree, untracked files in and ignored ones out, built in a scratch index. cp -p keeps
// the index's time, which git needs to notice a same-size edit made in the second the index was written.
const SNAPSHOT = 'd=$(mktemp -d) || exit 1; i="$d/index"; cp -p "$(git rev-parse --git-path index)" "$i" 2>/dev/null || rm -f "$i"; '
  + 'GIT_INDEX_FILE="$i" git add -A . >/dev/null 2>&1 && GIT_INDEX_FILE="$i" git write-tree; s=$?; rm -rf "$d"; exit $s';
// Each file's content hash in one git call: from a tree or commit when given (ls-tree), else from the working
// tree (hash-object on the files that exist, listed first so the hashes can be matched to them).
const HASHES = 'r=$1; shift; if [ -n "$r" ]; then git ls-tree -r -z "$r" -- "$@"; else '
  + 'e=$(for f; do [ -f "$f" ] && printf "%s\n" "$f"; done); printf "%s\n--\n" "$e"; '
  + '[ -n "$e" ] && printf "%s\n" "$e" | git hash-object --stdin-paths; fi';

// "path -> hash" from HASHES's answer; a path it doesn't name is gone, "-".
export function parseHashes(out, ref) {
  const map = new Map();
  if (ref) {
    for (const entry of out.split("\0")) {
      const m = /^\d+ \w+ ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
      if (m) map.set(m[2], m[1]);
    }
    return map;
  }
  const [names = "", sums = ""] = out.split("\n--\n");
  const paths = names.split("\n").filter(Boolean), hashes = sums.split("\n").filter(Boolean);
  paths.forEach((p, i) => hashes[i] && map.set(p, hashes[i]));
  return map;
}
const MAX_HASHED = 500;
// A review of a huge branch lists this many files; the rest are named by count, and ] and [ still reach them.
const FILES_SHOWN = 200;
// A ref keeps the seen tree from git's garbage collection.
const seenRef = (key) => {
  let h = 5381;
  for (const c of key) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  return `refs/relevo/seen/${h.toString(16)}`;
};

// An agent whose pane sits in this checkout; the one that made the changes is usually the only one.
function agentIn(root) {
  const byPane = new Map(panes().map((p) => [p.pane, p.cwd]));
  return agents().find((a) => {
    const cwd = byPane.get(a.pane) ?? "";
    return cwd === root || cwd.startsWith(`${root}/`);
  }) ?? null;
}

// Without `pr` it reviews the uncommitted changes; with `pr` ({repo, number, url, base, head, ref}) the whole PR
// against its base: the checkout's working tree, or the branch `ref` itself when it isn't checked out anywhere.
// `range` { from, to, label, file }: two fixed revisions, as a run's change, instead of the checkout's work.
export async function openReview(root = focusedCwd(), terminal = null, pr = null, back = null, range = null) {
  if (!root) return;
  const top = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: root })).stdout.trim();
  if (!top) return notify({ title: "Not a git repository", level: "info" });
  const pane = shared(OPEN)?.[reviewKey(top, pr, range)];
  if (pane && panes().some((p) => p.pane === pane)) return run("pane.focus", { pane });
  run("pane.split", { direction: "right", mod: "relevo", props: { role: "review-diff", root: top, terminal, pr, ...(back ? { back } : {}), ...(range ? { range } : {}) } });
}

// The review pane on the PR's checkout, else on its exact head; comments go to its agent, or a new one when none runs.
// Returns false when its head couldn't be fetched.
export async function reviewPR(pr, clone, terminal = null) {
  const info = { repo: pr.repo, number: pr.number, url: pr.url, base: pr.baseRefName, head: pr.headRefName };
  const folder = await checkoutOf(clone, localBranch(pr));
  if (!folder) {
    const r = await exec("git", ["-C", clone, "fetch", "--quiet", "origin", pullRefspec(pr)]);
    if (r.code !== 0) {
      notify({ title: `Could not fetch PR #${pr.number}`, body: r.stderr.trim().split("\n")[0], level: "warning" });
      return false;
    }
    info.ref = pullRef(pr);
  }
  await openReview(folder ?? clone, terminal, info);
  return true;
}

const reviewKey = (root, pr, range = null) => (range ? `${root}@${range.from}..${range.to}` : pr ? `${root}#${pr.number}` : root);

// Entries whose pane is gone drop out on the next write.
const live = () => Object.fromEntries(
  Object.entries(shared(OPEN) ?? {}).filter(([, pane]) => panes().some((p) => p.pane === pane)),
);

const sendChord = (e) => e.key === "enter" && Boolean(e.modifiers?.platform) && !e.modifiers.alt && !e.modifiers.control && !e.modifiers.shift;

// What handleKey and paneKey answer, for the Inbox's ? sheet.
export const REVIEW_SHORTCUT_ACTIONS = [
  { id: "review.comment", label: "Comment on the file", section: "Review pane", fixedShortcut: "c" },
  { id: "review.viewed", label: "Mark the file viewed", section: "Review pane", fixedShortcut: "v" },
  { id: "review.prev", label: "Previous file", section: "Review pane", fixedShortcut: "[" },
  { id: "review.next", label: "Next file", section: "Review pane", fixedShortcut: "]" },
  { id: "review.next-hunk", label: "Next hunk", section: "Review pane", fixedShortcut: "n" },
  { id: "review.prev-hunk", label: "Previous hunk", section: "Review pane", fixedShortcut: "p" },
  { id: "review.search", label: "Search in diff", section: "Review pane", fixedShortcut: "/" },
  { id: "review.send", label: "Send the comments to the agent", section: "Review pane", fixedShortcut: "cmd-enter" },
];

// The Files editor's syntax colors.
const SYNTAX = { keyword: "ansi5", string: "ansi2", comment: "dim", function: "ansi4", type: "ansi3", number: "ansi1", constant: "ansi6" };
const code = (t, tokens) => h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap()
  .children(tokens.map(([kind, text]) => div().flex_none().when(Boolean(kind), (el) => el.text_color(t[SYNTAX[kind]])).child(text)));

// A comment's label and text; `oneLine` cuts the text instead of wrapping it.
const noteLine = (t, c, oneLine = false) => h_flex().min_w(0).gap(8).items_center()
  .child(div().flex_none().text_size(11).text_color(t.accent).child(commentLabel(c)))
  .child(div().flex_1().min_w(0).when(oneLine, (el) => el.truncate()).text_size(13).text_color(t.foreground).child(c.text));

// An edit is of the file, of rows { start, end }, or of a saved comment { id } whose lines the diff no longer has.
const targetKey = (e) => (!e ? null : e === "file" ? "file" : e.id ? `id:${e.id}` : `${e.start}-${e.end}`);
const onRows = (e) => Boolean(e) && e !== "file" && !e.id;

export class ReviewDiff {
  init(_props, cx) {
    this.focus = cx.focus_handle();
    const p = props() ?? {};
    this.root = p.root ?? null;
    this.terminal = p.terminal ?? null;
    this.pr = p.pr ?? null;
    this.back = p.back ?? null;
    this.range = p.range ?? null;
    // Open panes and unsent comments are kept per checkout, and per PR or range when reviewing one.
    this.key = reviewKey(this.root, this.pr, this.range);
    // An agent's checkout whose branch has an open PR: "branch" shows only what the PR carries, its commits.
    this.branchPR = !this.pr && !this.range && this.terminal ? shared(AGENT_PRS)?.[this.terminal] ?? null : null;
    // Without a PR: "uncommitted", or "all" for the branch's commits too; "pr" with one; "seen" since the mark.
    this.scope = this.range ? "range" : this.pr ? "pr" : this.branchPR ? "branch" : "uncommitted";
    if (this.range?.file) this.open = { path: this.range.file };
    this.hashes = new Map();
    this.files = [];
    this.rows = [];
    this.comments = shared(NOTES)?.[this.key] ?? [];
    // null, { start, end } row indices, or "file".
    this.editing = null;
    this.anchor = null;
    this.searching = false;
    this.viewStart = 0;
    this.hunkAt = -1;
    this.matchAt = -1;
    this.posting = false;
    this.input = InputState.new({ value: "", placeholder: "Comment for the agent · Enter saves, Esc cancels" });
    this.input.on("submit", (_e, cx) => this.save(cx));
    this.search = InputState.new({ value: "", placeholder: "Find in diff… · Enter next, Esc close" });
    this.search.on("change", (_e, cx) => {
      this.matchAt = -1;
      this.jumpMatch(1, cx, { quiet: true });
    });
    this.search.on("submit", (_e, cx) => this.jumpMatch(1, cx));
    if (this.root) this.load(cx);
    if (this.pr && !this.range) this.readAbout(cx);
    // The agent keeps working while you read; pick up its changes unless you are typing.
    // Behind another app nobody reads it, so it waits until the window is back.
    cx.timer.every(10000, (cx) => {
      // A range names fixed revisions: there is nothing new to pick up.
      if (!this.range && this.editing === null && !this.loading && window()?.active !== false) this.load(cx);
    });
    // The split focuses the new pane, which is how this view learns its own id.
    cx.timer.after(300, () => {
      const pane = focused()?.pane;
      if (!this.root || !pane || panes().find((x) => x.pane === pane)?.mod !== "relevo") return;
      this.pane = pane;
      setShared(OPEN, { ...live(), [this.key]: pane });
      // The pane takes ⌘↵ only while it holds focus.
      if (this.editing === null) this.focus.focus();
    });
  }

  close() {
    this.closed = true;
    this.focus.release();
    this.input.release();
    this.search?.release();
    if (this.pane && shared(OPEN)?.[this.key] === this.pane) {
      const { [this.key]: _, ...rest } = live();
      setShared(OPEN, rest);
    }
  }

  load(cx) {
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        await this.read(cx);
      } finally {
        this.loading = false;
      }
    });
  }

  // The ref the diff starts from: HEAD for uncommitted work, the merge base with the branch's base otherwise.
  async since(git) {
    if (this.scope === "range") return this.range.from;
    if (this.scope === "seen") return this.seenMark()?.tree ?? "HEAD";
    if (!this.pr && this.scope !== "all" && this.scope !== "branch") return "HEAD";
    if (!this.mergeBase) {
      const named = this.pr?.base ?? (this.scope === "branch" ? this.branchPR.base : null);
      const remote = named ? await git(["rev-parse", "--verify", "--quiet", `origin/${named}`]) : null;
      const base = named ? (remote.code === 0 ? `origin/${named}` : named) : await baseBranch(this.root);
      this.baseName = base;
      this.mergeBase = base ? (await git(["merge-base", base, this.pr?.ref ?? "HEAD"])).stdout.trim() : "";
    }
    return this.mergeBase || "HEAD";
  }

  setScope(scope, cx) {
    if (scope === this.scope) return;
    Object.assign(this, { scope, mergeBase: null, filesSign: null, diffSign: null, editing: null, anchor: null, seenCache: null });
    this.load(cx);
    cx.notify();
  }

  // Reuses the last scratch tree in `scope === "seen"` while HEAD and the working tree's content are unchanged.
  // Status alone can't tell: a file edited again stays " M", so the tracked diff and untracked hashes sign it too.
  async seenSnapshot(git) {
    if (this.pr?.ref) return this.snapshot();
    const [head, st, diff, others] = await Promise.all([
      git(["rev-parse", "HEAD"]).catch(() => null),
      git(["status", "--porcelain", "--untracked-files=normal"]).catch(() => null),
      git(["diff", "HEAD", "--no-ext-diff", "--no-color"]).catch(() => null),
      git(["ls-files", "--others", "--exclude-standard", "-z"]).catch(() => null),
    ]);
    const names = String(others?.stdout ?? "").split("\0").filter(Boolean).slice(0, 500);
    const hashed = names.length ? await git(["hash-object", "--", ...names]).catch(() => null) : null;
    const sign = head?.code === 0 && st?.code === 0 && diff?.code === 0 && others?.code === 0 && (!names.length || hashed?.code === 0)
      ? `${head.stdout.trim()}\n${st.stdout}\n${diff.stdout}\n${hashed?.stdout ?? ""}` : null;
    if (sign && this.seenCache?.sign === sign && this.seenCache.tree) return this.seenCache.tree;
    const tree = await this.snapshot();
    if (sign && tree) this.seenCache = { sign, tree };
    return tree || null;
  }

  async read(cx) {
    const git = (args) => exec("git", [...READ, ...args], { cwd: this.root }), scope = this.scope;
    const from = await this.since(git);
    if (scope !== this.scope) return;
    this.from = from;
    // Since the mark, both sides are trees: the seen one and the working tree now, untracked files included.
    this.to = scope === "range" ? this.range.to : scope === "seen" ? await this.seenSnapshot(git)
      : scope === "branch" ? "HEAD" : this.pr?.ref ?? null;
    const range = this.to ? [this.from, this.to] : [this.from];
    const stat = (await git(["diff", ...range, "--numstat", "--summary", "--no-renames"])).stdout.split("\n").filter(Boolean);
    // --summary names the files the diff creates, after the counts.
    const created = new Set(stat.flatMap((l) => /^ create mode \d+ (.+)$/.exec(l)?.[1] ?? []));
    const tracked = stat.filter((l) => !l.startsWith(" ")).map((l) => {
      const [add, del, path] = l.split("\t");
      return { path, add: +add || 0, del: +del || 0, added: created.has(path), binary: add === "-" && del === "-" };
    });
    // A branch that isn't checked out has no untracked files.
    const others = this.to ? "" : (await git(["ls-files", "--others", "--exclude-standard"])).stdout;
    const untracked = others.split("\n").filter(Boolean).map((path) => ({ path, add: 0, del: 0, untracked: true, added: true }));
    // Switched while reading: the newer read draws.
    if (scope !== this.scope) return;
    const files = [...tracked, ...untracked];
    // Opened on work committed since: the first read shows the branch's changes instead of an empty pane.
    const first = !this.readOnce;
    this.readOnce = true;
    if (first && !files.length && scope === "uncommitted") {
      Object.assign(this, { scope: "all", mergeBase: null, filesSign: null, diffSign: null });
      cx.notify();
      return this.read(cx);
    }
    const hashed = files.slice(0, MAX_HASHED).map((f) => f.path);
    const found = hashed.length ? parseHashes((await exec("sh", ["-c", HASHES, "sh", this.to ?? "", ...hashed], { cwd: this.root })).stdout, this.to) : new Map();
    this.hashes = new Map(hashed.map((p) => [p, found.get(p) ?? "-"]));
    const sign = JSON.stringify([files, [...this.hashes.values()]]);
    if (sign !== this.filesSign) {
      this.filesSign = sign;
      this.files = files;
      cx.notify();
    }
    const open = files.find((f) => f.path === this.open?.path) ?? files[0];
    // The open file's diff is read again only when its content or the range moved.
    const key = open ? JSON.stringify([this.from, this.to, open.path, this.hashes.get(open.path) ?? null]) : null;
    if (open && (key !== this.openKey || [undefined, "-"].includes(this.hashes.get(open.path)))) await this.pick(open, cx, key);
    else if (!open) Object.assign(this, { rows: [], open: null, diffSign: null, openKey: null });
  }

  // Why the PR exists, shown before its files. Others' PRs are untrusted text, so it goes through agentMarkdown.
  readAbout(cx) {
    cx.spawn(async (cx) => {
      const r = await exec("gh", ["pr", "view", String(this.pr.number), "--repo", this.pr.repo, "--json", "title,body"], { timeout: 20000 }).catch(() => null);
      let about = null;
      try { about = JSON.parse(r?.stdout ?? ""); } catch { /* no gh or no access: files only */ }
      if (this.closed || !about?.body?.trim()) return;
      this.about = { title: about.title ?? "", body: agentMarkdown(about.body) };
      if (!this.chose) this.reading = true;
      cx.notify();
    });
  }

  // A file the person picked; read() picks on its own too, which must not leave the description.
  async showFile(file, cx) {
    this.chose = true;
    this.reading = false;
    cx.notify();
    if (file) await this.pick(file, cx);
  }

  showAbout(cx) {
    this.editing = null;
    this.reading = true;
    cx.notify();
  }

  async pick(file, cx, key = null) {
    if (this.open?.path !== file.path) {
      this.editing = null;
      this.anchor = null;
      this.diffSign = null;
      this.viewStart = 0;
      this.hunkAt = -1;
      this.matchAt = -1;
    }
    this.open = file;
    const picked = this.picked = (this.picked ?? 0) + 1;
    const args = file.untracked
      ? ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", file.path]
      : ["diff", this.from ?? "HEAD", ...(this.to ? [this.to] : []), "--no-color", "--no-ext-diff", "--", file.path];
    const out = (await exec("git", [...READ, ...args], { cwd: this.root })).stdout;
    // A later pick (another file, or the next read) owns the pane now; this diff is no longer the open file's.
    if (picked !== this.picked) return;
    this.openKey = key;
    const sign = signOf(out);
    if (sign === this.diffSign) return;
    this.diffSign = sign;
    this.anchor = null;
    // Bound raw lines before diff parsing so huge diffs don't stall the UI thread.
    const rawLines = out.split("\n");
    const bounded = rawLines.length > MAX_ROWS * 2 ? rawLines.slice(0, MAX_ROWS * 2) : rawLines;
    this.rows = highlightRows(diffRows(bounded).slice(0, MAX_ROWS), languageFor(file.path));
    cx.notify();
  }

  // A shift-click extends from the last plain click; the press records shift because on_item_click has no event.
  clickRow(i, cx) {
    if (this.rows[i]?.number === undefined) return;
    const range = this.shift && this.anchor !== null ? selectRange(this.rows, this.anchor, i) : null;
    if (!range) this.anchor = i;
    this.edit(range ?? { start: i, end: i }, cx);
  }

  clickNote(id, cx) {
    const c = this.comments.find((x) => x.file === this.open?.path && commentId(x) === id);
    if (c) this.openComment(c, cx);
  }

  // Opens a saved comment as it was saved: on its rows when the diff still has them all, by its id otherwise.
  openComment(c, cx) {
    if (c.scope === "file") return this.edit("file", cx);
    const at = (key) => this.rows.findIndex((r) => r.number !== undefined && lineKey(r) === key);
    const end = at(c.key), start = c.start ? at(c.start) : end;
    if (end < 0 || start < 0 || start > end) return this.edit({ id: commentId(c) }, cx);
    this.anchor = start;
    this.edit({ start, end }, cx);
  }

  edit(target, cx) {
    const e = this.editing;
    if (targetKey(e) === targetKey(target)) return;
    const id = target === "file" ? "file" : target.id ?? commentId(lineComment("", this.rows, target.start, target.end, ""));
    const saved = this.comments.find((c) => c.file === this.open.path && commentId(c) === id)?.text;
    // Widening a fresh line comment into a range keeps what was typed.
    const widening = onRows(e) && onRows(target) && target.start !== target.end;
    this.input.set_value(saved ?? (widening ? this.input.value() : ""));
    this.note = null;
    this.editing = target;
    cx.timer.after(30, () => { if (!this.closed && this.editing === target) this.input.focus(); });
    cx.notify();
  }

  save(cx) {
    const text = this.input.value().trim(), e = this.editing;
    const stored = e?.id ? this.editingComment() : null;
    const ok = e === "file" ? Boolean(this.open) : e?.id ? stored : this.rows[e?.start] && this.rows[e?.end];
    if (!ok) {
      this.editing = null;
      return cx.notify();
    }
    if (!text) { this.note = "Enter a comment, or use Delete comment to remove it."; return cx.notify(); }
    const c = e === "file" ? fileComment(this.open.path, text) : stored ? { ...stored, text } : lineComment(this.open.path, this.rows, e.start, e.end, text);
    const kept = this.comments.filter((x) => !(x.file === c.file && commentId(x) === commentId(c)));
    this.setComments([...kept, ...(text ? [c] : [])]);
    this.note = "Comment saved locally";
    this.cancelEdit(cx);
  }

  editingComment() {
    const e = this.editing;
    if (e === null || !this.open) return null;
    if (onRows(e) && (!this.rows[e.start] || !this.rows[e.end])) return null;
    const id = e === "file" ? "file" : e.id ?? commentId(lineComment("", this.rows, e.start, e.end, ""));
    return this.comments.find((c) => c.file === this.open.path && commentId(c) === id) ?? null;
  }

  cancelEdit(cx) {
    this.editing = null;
    this.anchor = null;
    this.input.set_value("");
    this.focus.focus();
    cx.notify();
  }

  deleteComment(cx) {
    const comment = this.editingComment();
    if (comment) this.removeComment(comment, cx);
  }

  // An edit of another comment stays open.
  removeComment(comment, cx) {
    const same = (c) => c.file === comment.file && commentId(c) === commentId(comment);
    if (!this.comments.some(same)) return;
    const editing = this.editingComment(), open = Boolean(editing) && same(editing);
    this.setComments(this.comments.filter((c) => !same(c)));
    this.note = "Comment deleted";
    if (open) this.cancelEdit(cx);
    else cx.notify();
  }

  setComments(list) {
    this.comments = list;
    this.clearing = false;
    const all = { ...(shared(NOTES) ?? {}) };
    if (list.length) all[this.key] = list;
    else delete all[this.key];
    setShared(NOTES, all);
  }

  seenMark() {
    return shared(SEEN)?.[this.key] ?? null;
  }

  async snapshot() {
    if (this.pr?.ref) return (await exec("git", [...READ, "rev-parse", this.pr.ref], { cwd: this.root })).stdout.trim();
    const r = await exec("sh", ["-c", SNAPSHOT], { cwd: this.root });
    return r.code === 0 ? r.stdout.trim() : "";
  }

  // What the review shows now becomes where Since I looked starts.
  async markSeen(cx) {
    const tree = await this.snapshot();
    if (!tree) {
      this.note = "Could not save a review checkpoint";
      return cx.notify();
    }
    const result = await exec("git", ["update-ref", seenRef(this.key), tree], { cwd: this.root });
    if (result.code !== 0) { this.note = "Could not save a review checkpoint"; return cx.notify(); }
    setShared(SEEN, keepLatest(shared(SEEN), this.key, { tree, at: Math.round(Date.now() / 1000) }));
    cx.notify();
  }

  // A draw asks this for every file: it reads the marks once (`marksNow`, set while render runs).
  viewed(path) {
    const hash = this.hashes.get(path);
    return Boolean(hash) && (this.marksNow ?? shared(VIEWED)?.[this.key] ?? {})[path] === hash;
  }

  toggleViewed(path, cx) {
    if (!this.hashes.get(path)) return;
    const all = shared(VIEWED) ?? {}, mine = { ...(all[this.key] ?? {}) };
    if (this.viewed(path)) delete mine[path];
    else mine[path] = this.hashes.get(path);
    // Only files still in the review keep their mark, so the list doesn't grow.
    const listed = new Set(this.files.map((f) => f.path));
    setShared(VIEWED, keepLatest(all, this.key, Object.fromEntries(Object.entries(mine).filter(([p]) => listed.has(p)))));
    cx.notify();
  }

  markAllViewed(cx) {
    const mine = Object.fromEntries(this.files.flatMap(({ path }) => this.hashes.get(path) ? [[path, this.hashes.get(path)]] : []));
    setShared(VIEWED, keepLatest(shared(VIEWED), this.key, mine));
    cx.notify();
  }

  subject() {
    if (this.scope === "seen") return `what changed since I last looked${this.pr ? ` at PR #${this.pr.number} (${this.pr.url})` : ""}`;
    if (this.scope === "branch") return `PR #${this.branchPR.number} (${this.branchPR.url}): the branch's commits against ${this.baseName}`;
    if (!this.pr) return this.scope === "all" && this.mergeBase ? `the branch against ${this.baseName}, committed and uncommitted` : undefined;
    const where = this.pr.ref ? `; it is not checked out here, so work on it in a worktree (gh pr checkout ${this.pr.number})` : "";
    return `PR #${this.pr.number} (${this.pr.url}), the branch against ${this.pr.base}${where}`;
  }

  target() {
    return this.terminal ? agents().find((a) => a.address === this.terminal) ?? null : agentIn(this.root);
  }

  ready(agent = this.target()) {
    return Boolean((agent || this.pr) && this.comments.length && this.editing === null && !this.sending && !this.posting);
  }

  send(cx) {
    const agent = this.target();
    if (!this.comments.length || this.sending) return;
    cx.spawn(async (cx) => {
      await this.markSeen(cx);
    });
    // A PR with no agent on it gets a new one in its checkout, with the repo's account.
    if (!agent && this.pr) {
      const message = reviewMessage(this.comments, this.subject());
      launchInRepo({
        repo: this.pr.repo, folder: this.root, tab: `${this.pr.repo.split("/")[1]}#${this.pr.number} · review`,
        account: accountFor(this.pr.repo), prompt: message,
      });
      this.setComments([]);
      this.note = "Sent to a new agent";
      return cx.notify();
    }
    if (!agent) return;
    const message = reviewMessage(this.comments, this.subject());
    // Until hc send answers the comments are still here, so a second press would send them twice.
    this.sending = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("hc", ["send", agent.address, message]);
        if (r.code !== 0) this.note = r.stderr.trim().split("\n")[0] || "hc send failed";
        else {
          this.setComments([]);
          this.note = `Sent to ${agent.tab_name || agent.address}`;
          run("agent.focus", { terminal: agent.address });
        }
      } finally {
        this.sending = false;
        cx.notify();
      }
    });
  }

  postDraftReview(cx) {
    if (!this.pr || !this.comments.length || this.posting || this.sending) return;
    const [, owner, repo] = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(this.pr.url ?? "") ?? [];
    if (!owner || !repo) {
      this.note = "Not a GitHub pull request URL";
      return cx.notify();
    }
    this.posting = true;
    const posted = new Set(this.comments);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // Line numbers come from this checkout: GitHub must anchor them to the same commit, with nothing uncommitted on top.
        const git = (args) => exec("git", [...READ, ...args], { cwd: this.root });
        if (!this.pr.ref && (await git(["diff", "--quiet", "HEAD", "--", ...new Set(this.comments.map((c) => c.file))])).code !== 0) {
          this.note = "Commit and push the commented files first, or send the comments to the agent";
          return;
        }
        const commit = (await git(["rev-parse", "--verify", this.pr.ref ?? "HEAD"])).stdout.trim();
        const post = (review) => exec("sh", ["-c", 'printf "%s" "$1" | gh api -X POST "$2" --input -', "sh",
          JSON.stringify({ ...review, ...(commit ? { commit_id: commit } : {}) }), `repos/${owner}/${repo}/pulls/${this.pr.number}/reviews`]);
        let r = await post(githubDraftReview(this.comments, true)), inline = true;
        if (r.code !== 0 && /commit_id|commit sha|no commit found/i.test(r.stderr ?? "")) {
          this.note = "This checkout's commit is not on the PR yet: push it before posting";
          return;
        }
        if (r.code !== 0 && /line|position|diff|422/i.test(r.stderr ?? "")) { inline = false; r = await post(githubDraftReview(this.comments, false)); }
        if (r.code !== 0) {
          this.note = (r.stderr || "gh failed").trim().split("\n")[0];
        } else {
          let url = this.pr.url;
          try { url = JSON.parse(r.stdout || "{}").html_url ?? url; } catch { /* keep PR url */ }
          await this.markSeen(cx);
          this.setComments(this.comments.filter((c) => !posted.has(c)));
          this.note = inline ? "Draft review saved on GitHub" : "Draft review saved on GitHub · comments are in the review body, not inline";
          openUrl(url);
        }
      } finally {
        this.posting = false;
        cx.notify();
      }
    });
  }

  jumpToRow(rowIndex) {
    const { items } = this.diffModel();
    const at = items.indexOf(rowIndex);
    this.viewStart = at > 0 ? Math.max(0, at - 2) : 0;
  }

  jumpHunk(delta, cx) {
    const hunks = hunkIndices(this.rows);
    if (!hunks.length) return;
    if (this.hunkAt < 0) this.hunkAt = delta > 0 ? 0 : hunks.length - 1;
    else this.hunkAt = (this.hunkAt + delta + hunks.length) % hunks.length;
    this.jumpToRow(hunks[this.hunkAt]);
    cx.notify();
  }

  openSearch(cx) {
    this.searching = true;
    this.search?.focus();
    cx.notify();
  }

  closeSearch(cx) {
    this.searching = false;
    this.search?.set_value("");
    this.matchAt = -1;
    this.viewStart = 0;
    this.focus.focus();
    cx.notify();
  }

  jumpMatch(delta, cx, { quiet = false } = {}) {
    const matches = searchMatches(this.rows, this.search?.value() ?? "");
    if (!matches.length) {
      this.matchAt = -1;
      if (!quiet) this.viewStart = 0;
      return cx.notify();
    }
    if (this.matchAt < 0) this.matchAt = delta > 0 ? 0 : matches.length - 1;
    else this.matchAt = (this.matchAt + delta + matches.length) % matches.length;
    this.jumpToRow(matches[this.matchAt]);
    cx.notify();
  }

  escapeKey(e, cx) {
    if (e.key !== "escape") return false;
    if (this.editing !== null) {
      cx.stop_propagation();
      this.cancelEdit(cx);
      return true;
    }
    if (this.searching) {
      cx.stop_propagation();
      this.closeSearch(cx);
      return true;
    }
    return false;
  }

  // ⌘↵ is the Send button and waits for the same things; a held key repeats, and one press sends once.
  handleKey(e, cx) {
    if (this.escapeKey(e, cx) || this.paneKey(e, cx)) return;
    if (!sendChord(e) || e.is_held || !this.ready()) return;
    cx.stop_propagation();
    this.send(cx);
  }

  // While no comment/search is open: c comments on the file, v marks it viewed, [ ] switch files, n p jump hunks, / searches.
  paneKey(e, cx) {
    const m = e.modifiers ?? {};
    if (this.editing !== null || this.searching || m.platform || m.control || m.alt) return false;
    if (this.reading) {
      if (e.key !== "]" || !this.files.length) return false;
      cx.spawn(async (cx) => { await this.showFile(this.files.find((f) => f.path === this.open?.path) ?? this.files[0], cx); });
      cx.stop_propagation();
      return true;
    }
    if (!this.open) return false;
    const at = (this.files ?? []).findIndex((f) => f.path === this.open.path), step = e.key === "[" ? -1 : e.key === "]" ? 1 : 0;
    if (e.key === "c") this.edit("file", cx);
    else if (e.key === "v" && this.hashes?.get(this.open.path)) this.toggleViewed(this.open.path, cx);
    else if (e.key === "n") this.jumpHunk(1, cx);
    else if (e.key === "p") this.jumpHunk(-1, cx);
    else if (e.key === "/") this.openSearch(cx);
    else if (step < 0 && at === 0 && this.about) this.showAbout(cx);
    else if (step && this.files[at + step]) cx.spawn(async (cx) => { await this.showFile(this.files[at + step], cx); });
    else return false;
    cx.stop_propagation();
    return true;
  }

  // Runs inside the virtual list: no handlers here, clicks go through on_item_click.
  row(t, r, i, noted, tint, matched = false, activeMatch = false) {
    const e = this.editing, marked = onRows(e) && i >= e.start && i <= e.end;
    if (r.kind === "@") {
      const hunks = hunkIndices(this.rows), active = this.hunkAt >= 0 && hunks[this.hunkAt] === i;
      return div().w_full().px(12).h(20).flex_none().truncate().bg(active ? t.selected : t.raised).text_color(active ? t.foreground : t.dim).child(r.text);
    }
    return h_flex().w_full().h(20).flex_none().gap(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .when(r.kind === "+", (el) => el.bg(t.ansi2 + "18"))
      .when(r.kind === "-", (el) => el.bg(t.ansi1 + "18"))
      .when(matched && !marked, (el) => el.bg(t.ansi3 + (activeMatch ? "40" : "22")))
      .when(tint && !marked && !matched, (el) => el.bg(t.accent + "1f"))
      .when(marked, (el) => el.bg(t.selected))
      .child(div().w(30).flex_none().text_right().text_color(noted ? t.accent : t.dim).child(String(r.number)))
      .child(h_flex().w(12).flex_none().when(noted, (el) => el.child(icon("comment", t.accent))))
      .child(r.tokens ? code(t, r.tokens) : div().flex_1().min_w(0).truncate().child(r.text));
  }

  // Also a row of the virtual list, so it only opens the comment; deleting is in the strip above the footer.
  noteBox(t, note, font) {
    return noteLine(t, note).mx(10).my(3).px(8).py(4).rounded(6).bg(t.raised).font_family(font).cursor_pointer();
  }

  // The open file's saved comments as real elements: the diff list's rows can't hold a button.
  savedStrip(t, font, mine) {
    return v_flex().id("rv-saved").flex_none().max_h(96).overflow_y_scrollbar().px(10).py(4).border_t(1).border_color(t.border).font_family(font)
      .children(mine.map((c) => h_flex().h(24).flex_none().gap(8).items_center()
        .child(button(t, `rv-edit-${commentId(c)}`, [noteLine(t, c, true).flex_1()], (cx) => this.openComment(c, cx),
          { kind: "ghost", size: "sm", accessibleLabel: `Edit comment ${commentLabel(c)}: ${c.text}` }).flex_1().min_w(0))
        .child(button(t, `rv-del-${commentId(c)}`, [icon("x")], (cx) => this.removeComment(c, cx), { kind: "ghost", size: "sm", tip: "Delete this comment" }))));
  }

  field(t, font) {
    return div().id("rv-comment-field").mx(10).my(4).h(30).px(8).flex().items_center()
      .rounded(6).border_1().border_color(t.accent).bg(t.background)
      .font_family(font).text_size(13)
      // ⌘↵ in the field belongs to the comment: the pane must not take it as Send.
      .on_key_down((e, cx) => {
        if (!sendChord(e)) return;
        cx.stop_propagation();
        if (this.editing !== null) this.save(cx);
      })
      .child(Input.new(this.input).id("rv-comment-input").accessibility_label("Review comment").h_full());
  }

  commentEditor(t, font) {
    const e = this.editing, saved = this.editingComment();
    const at = e === "file" ? fileComment("", "") : e?.id ? saved : this.rows[e?.start] && this.rows[e?.end] ? lineComment("", this.rows, e.start, e.end, "") : null;
    // Retained inputs and action handlers live outside the virtual diff rows.
    return v_flex().id("rv-comment-editor").flex_none().py(6).gap(4).border_t(1).border_color(t.accent)
      .child(div().px(10).text_size(11).child(`${saved ? "Edit" : "Add"} comment · ${this.open?.path}${at ? ` · ${commentLabel(at)}` : ""}`))
      .child(this.field(t, font))
      .child(h_flex().px(10).gap(6).flex_wrap()
        .child(button(t, "rv-comment-save", "Save comment", (cx) => this.save(cx), { kind: "solid", tip: "Enter saves locally. Send to agent delivers saved comments." }))
        .child(button(t, "rv-comment-cancel", "Cancel", (cx) => this.cancelEdit(cx), { tip: "Esc discards this edit and keeps any previously saved comment" }))
        .when(Boolean(saved), (el) => el.child(button(t, "rv-comment-delete", "Delete comment", (cx) => this.deleteComment(cx), { kind: "danger", tip: "Remove only this saved comment" }))));
  }

  header(t) {
    return h_flex().flex_none().flex_wrap().px(12).py(6).gap(8).items_center().border_b(1).border_color(t.border)
      .when(Boolean(this.back), (el) => el.child(button(t, "rv-back-decision", "← Back to decision", () => openWorkflow(this.back.goalId, this.back.taskId), { size: "sm" })))
      .child(div().font_semibold().child("Review"))
      .child(div().flex_1().min_w(80).truncate().text_size(11).text_color(t.dim)
        .child(this.range ? this.range.label ?? this.root?.split("/").pop()
          : this.pr
          ? `${this.pr.repo.split("/")[1]} #${this.pr.number} · against ${this.pr.base}`
          : `${this.root?.split("/").pop() ?? "No folder"}${this.scope === "all" && this.mergeBase ? ` · against ${this.baseName}` : ""}`))
      .when(!this.range && (!this.pr || Boolean(this.seenMark())), (el) => el.child(this.scopePicker(t)))
      .when(this.files.length > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim)
        .child(`${this.files.filter((f) => this.viewed(f.path)).length} of ${this.files.length} viewed`)))
      .child(button(t, "rv-mark-all-viewed", "Mark all viewed", (cx) => this.markAllViewed(cx),
        { size: "sm", disabled: !this.files.some((f) => this.hashes.get(f.path) && !this.viewed(f.path)), tip: "Mark every file in this review as viewed. Changed files become unviewed again." }))
      .when(!this.range, (el) => el.child(button(t, "rv-mark-seen", "Save checkpoint", (cx) => cx.spawn(async (cx) => {
        await this.markSeen(cx);
      }), { size: "sm", tip: "Set the baseline for Since I looked. This does not mark files viewed. Sending comments saves a checkpoint too." })));
  }

  scopePicker(t) {
    const tips = { pr: "Review the entire PR against its base", branch: "Only what the PR carries: the branch's commits, no uncommitted or untracked files", uncommitted: "Review working tree changes, including new files",
      all: "Review committed and uncommitted changes against the branch base", seen: "Review changes since your last saved checkpoint" };
    const pick = (scope, label) => button(t, `rv-scope-${scope}`, label, (cx) => this.setScope(scope, cx),
      { size: "sm", selected: this.scope === scope, kind: this.scope === scope ? "solid" : "outline", tip: tips[scope] });
    const options = this.pr ? [["pr", "Whole PR"]]
      : [...(this.branchPR ? [["branch", `PR #${this.branchPR.number}`]] : []), ["uncommitted", "Uncommitted"], ["all", "All changes"]];
    if (this.seenMark()) options.push(["seen", "Since I looked"]);
    return h_flex().id("rv-scope").flex_wrap().min_w(0).p(1).gap(3).rounded(5).bg(t.raised)
      .children(options.map(([scope, label]) => pick(scope, label)));
  }

  empty() {
    if (this.scope === "seen") return `Nothing changed since you looked, ${ago(this.seenMark()?.at ?? 0)}`;
    if (this.scope === "branch") return this.mergeBase ? `No commits against ${this.baseName}` : "No base branch to compare with";
    if (this.scope !== "all") return "No uncommitted changes";
    return this.mergeBase ? `No changes against ${this.baseName}` : "No base branch to compare with";
  }

  // Outside the virtual list, so ordinary handlers work here.
  fileBar(t, font, mine) {
    const note = mine.find((c) => c.scope === "file");
    const hunks = hunkIndices(this.rows), matches = this.searching ? searchMatches(this.rows, this.search?.value() ?? "") : [];
    return v_flex().flex_none().border_b(1).border_color(t.border)
      .child(h_flex().min_h(30).px(12).gap(6).flex_wrap().items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.open.path))
        .when(hunks.length > 1, (el) => el.child(h_flex().id("rv-hunks").gap(2).items_center()
          .child(button(t, "rv-hunk-prev", "‹", (cx) => this.jumpHunk(-1, cx), { kind: "ghost", size: "sm", tip: "Previous hunk · p" }))
          .child(div().text_size(11).text_color(t.dim).child(`${this.hunkAt >= 0 ? this.hunkAt + 1 : 1}/${hunks.length}`))
          .child(button(t, "rv-hunk-next", "›", (cx) => this.jumpHunk(1, cx), { kind: "ghost", size: "sm", tip: "Next hunk · n" }))))
        .child(button(t, "rv-search-open", [icon("search", this.searching ? t.accent : t.muted, 11)], (cx) => (this.searching ? this.closeSearch(cx) : this.openSearch(cx)),
          { kind: "ghost", size: "sm", tip: "Search in diff · /", accessibleLabel: "Search in diff" }))
        .child(button(t, "rv-file-viewed", this.viewed(this.open.path) ? "Mark unviewed" : "Mark file viewed", (cx) => this.toggleViewed(this.open.path, cx),
          { size: "sm", disabled: !this.hashes.get(this.open.path), tip: "Change the viewed status of the selected file" }))
        .child(button(t, "rv-file-comment", "Comment on file", (cx) => this.edit("file", cx), { size: "sm" })))
      .when(Boolean(this.searching), (el) => el.child(h_flex().id("rv-search").px(12).pb(6).gap(6).items_center()
        .child(h_flex().flex_1().min_w(0).h(26).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.accent).bg(t.background)
          .on_key_down((e, cx) => {
            if (e.key === "escape") { cx.stop_propagation(); this.closeSearch(cx); }
            else if (e.key === "enter" && e.modifiers?.shift) { cx.stop_propagation(); this.jumpMatch(-1, cx); }
          })
          .child(icon("search", t.dim, 11))
          .child(div().flex_1().min_w(0).child(Input.new(this.search).id("rv-search-input").h_full())))
        .child(div().id("rv-search-count").flex_none().text_size(11).text_color(t.dim)
          .child(matches.length ? `${this.matchAt >= 0 ? this.matchAt + 1 : 1}/${matches.length}` : (this.search?.value()?.trim() ? "0 matches" : "")))
        .child(button(t, "rv-search-prev", "‹", (cx) => this.jumpMatch(-1, cx), { kind: "ghost", size: "sm", disabled: !matches.length, tip: "Previous match · ⇧↵" }))
        .child(button(t, "rv-search-next", "›", (cx) => this.jumpMatch(1, cx), { kind: "ghost", size: "sm", disabled: !matches.length, tip: "Next match · ↵" }))
        .child(button(t, "rv-search-close", [icon("x")], (cx) => this.closeSearch(cx), { kind: "ghost", size: "sm", tip: "Close search · Esc" }))))
      .when(Boolean(note) && this.editing !== "file", (el) => el.child(this.noteBox(t, note, font)
        .id("rv-file-note")
        .on_click((_e, cx) => this.edit("file", cx))));
  }

  fileList(t) {
    const counts = new Map();
    for (const c of this.comments) counts.set(c.file, (counts.get(c.file) ?? 0) + 1);
    const rows = this.files.length + (this.about ? 1 : 0);
    return v_flex().id("rv-files").flex_none().h(Math.min(150, Math.max(40, rows * 24 + 9))).overflow_y_scrollbar().p(4).border_b(1).border_color(t.border)
      .when(Boolean(this.about), (el) => el.child(h_flex().id("rv-about-row").h(24).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .when(Boolean(this.reading), (r) => r.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.showAbout(cx))
        .child(icon("note", this.reading ? t.foreground : t.muted, 14))
        .child(div().flex_1().min_w(0).truncate().text_size(13).child("Description"))))
      .when(!this.files.length, (el) => el.child(div().p(8).text_color(t.dim).child(this.pr ? "No changes" : this.empty())))
      .children(this.files.slice(0, FILES_SHOWN).map((f) => {
        const count = counts.get(f.path) ?? 0;
        const seen = this.viewed(f.path), cut = f.path.lastIndexOf("/") + 1;
        return h_flex().id(`rv-file-${f.path}`).h(24).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .when(!this.reading && this.open?.path === f.path, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => cx.spawn(async (cx) => {
            await this.showFile(f, cx);
          }))
          .child(button(t, `rv-viewed-${f.path}`, [checkbox(t, seen)], (cx) => this.toggleViewed(f.path, cx),
            { size: "sm", selected: seen, disabled: !this.hashes.get(f.path), accessibleLabel: `${seen ? "Mark unviewed" : "Mark viewed"}: ${f.path}`, tip: "Viewed files become unviewed if their contents change" }))
          .child(h_flex().flex_1().min_w(0).gap(2).items_baseline().overflow_hidden()
            .when(cut > 0, (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(f.path.slice(0, cut))))
            .child(div().flex_none().text_size(13).text_color(seen ? t.dim : t.foreground).child(f.path.slice(cut))))
          .when(count > 0, (el) => el.child(tag(t, icon("comment", t.accent, 10)).id(`rv-count-${f.path}`).gap(3).child(String(count))))
          .when(Boolean(f.added) && !f.untracked, (el) => el.child(tag(t, "new", t.ansi2).id(`rv-tag-new-${f.path}`)))
          .when(Boolean(f.untracked), (el) => el.child(tag(t, "untracked", t.muted).id(`rv-tag-untracked-${f.path}`)
            .tooltip(this.branchPR ? `Never committed: not in PR #${this.branchPR.number}` : "Never committed")))
          .when(Boolean(f.binary), (el) => el.child(tag(t, "binary", t.muted).id(`rv-tag-binary-${f.path}`)))
          .when(!f.untracked && !f.binary, (el) => el
            .when(f.add > 0 || !f.del, (n) => n.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
            .when(f.del > 0, (n) => n.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))
            .child(diffRatio(t, f.add, f.del)));
      }))
      .when(this.files.length > FILES_SHOWN, (el) => el.child(div().id("rv-files-more").h(24).px(8).flex().items_center().text_size(11).text_color(t.dim)
        .tooltip("] and [ go to the next and previous file").child(`${this.files.length - FILES_SHOWN} more files`)));
  }

  // What the diff list draws, rebuilt only when the rows, the comments or the open file change: typing redraws too.
  diffModel() {
    const m = this.model;
    if (m && m.rows === this.rows && m.comments === this.comments && m.open === this.open) return m;
    const mine = this.comments.filter((c) => c.file === this.open?.path && c.scope !== "file");
    const notes = new Map();
    for (const c of mine) notes.set(c.key, [...(notes.get(c.key) ?? []), c]);
    const items = [];
    this.rows.forEach((r, i) => {
      items.push(i);
      if (r.number !== undefined) items.push(...(notes.get(lineKey(r)) ?? []));
    });
    // The icon sits where a comment starts; its box follows the last line it covers.
    this.model = { rows: this.rows, comments: this.comments, open: this.open, items,
      starts: new Set(mine.map((c) => c.start ?? c.key)), tinted: rangeRows(this.rows, mine) };
    return this.model;
  }

  diff(t, font) {
    const { items: allItems, starts, tinted } = this.diffModel();
    const offset = this.viewStart > 0 && this.viewStart < allItems.length ? this.viewStart : 0;
    const items = offset ? allItems.slice(offset) : allItems;
    const matches = this.searching ? searchMatches(this.rows, this.search?.value() ?? "") : [];
    const matchSet = matches.length ? new Set(matches) : null;
    const activeRow = matches.length && this.matchAt >= 0 ? matches[this.matchAt] : -1;
    const isRow = (n) => typeof items[n] === "number";
    const key = (n) => (isRow(n) ? String(items[n]) : `c:${commentId(items[n])}`);
    const item = (n) => {
      if (!isRow(n)) return this.noteBox(t, items[n], font);
      const i = items[n], r = this.rows[i];
      return this.row(t, r, i, r.number !== undefined && starts.has(lineKey(r)), tinted.has(i), Boolean(matchSet?.has(i)), i === activeRow);
    };
    return v_flex().id("rv-diff-area").flex_1().min_h(0)
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
      .on_mouse_down("left", (e) => {
        this.shift = e.modifiers.shift;
      })
      .when(offset > 0, (el) => el.child(h_flex().id("rv-top-banner").h(24).flex_none().px(12).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(11).text_color(t.dim).child(`↑ ${offset} lines above`))
        .child(button(t, "rv-show-top", "Show from top", (cx) => { this.viewStart = 0; cx.notify(); }, { kind: "ghost", size: "sm" }))))
      .child(div().flex_1().min_h(0).relative()
        .child(list("rv-diff", items.length, key, item)
          .size_full()
          .on_item_click((id, cx) => (id.startsWith("c:") ? this.clickNote(id.slice(2), cx) : this.clickRow(+id, cx))))
        .child(Scrollbar.vertical("rv-diff").absolute().inset_0()));
  }

  description(t) {
    return v_flex().id("rv-about").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).gap(10)
      .child(div().font_semibold().text_size(13).child(this.about.title))
      .child(TextView.markdown("rv-about-body", this.about.body).selectable(true).on_link_click(() => {}).w_full().text_size(13).text_color(t.foreground));
  }

  footer(t, agent, n, ready, mine = []) {
    return h_flex().h(44).flex_none().px(10).gap(8).items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted)
        .child(this.note ?? (agent
          ? `${n} ${n === 1 ? "comment" : "comments"} for ${agent.tab_name || agent.address}`
          : this.pr ? "A new agent will take them" : "No agent in this folder")))
      .when(mine.length > 0, (el) => el.child(button(t, "rv-saved-toggle", `${mine.length} here ${this.savedOpen ? "▴" : "▾"}`, (cx) => {
        this.savedOpen = !this.savedOpen;
        cx.notify();
      }, { kind: "ghost", size: "sm", tip: "Show or hide saved comments in this file" })))
      .when(n > 0, (el) => el.child(button(t, "rv-clear", this.clearing ? "Confirm" : "Clear", (cx) => {
        if (this.clearing) this.setComments([]);
        else this.clearing = true;
        cx.notify();
      }, { size: "lg", kind: this.clearing ? "danger" : "outline" })))
      .when(Boolean(this.pr) && n > 0, (el) => el.child(button(t, "rv-post-github", this.posting ? "Posting…" : "Post draft review",
        (cx) => this.postDraftReview(cx), { kind: "outline", size: "lg", disabled: !ready || this.posting,
          tip: "Saves these comments as a pending draft review on GitHub for you to edit and submit" })))
      .child(h_flex().id("rv-send-key").flex_none().gap(2).child(keycap(t, "⌘")).child(keycap(t, "enter")))
      .child(button(t, "rv-send", "Send to agent", (cx) => this.send(cx), { kind: "solid", size: "lg", disabled: !ready,
        tip: this.editing !== null ? "Save or cancel the current edit before sending comments" : "Send saved review comments to the agent · ⌘↵" }));
  }

  render() {
    this.marksNow = shared(VIEWED)?.[this.key] ?? {};
    try {
      return this.draw();
    } finally {
      this.marksNow = null;
    }
  }

  draw() {
    const t = theme(), agent = this.target(), n = this.comments.length, ready = this.ready(agent);
    const font = settings().ui_font_family ?? "Inter", mine = this.comments.filter((c) => c.file === this.open?.path);
    return v_flex().id("relevo-review").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.focus)
      .on_mouse_down("left", () => { if (this.editing === null) this.focus.focus(); })
      // The mouse's back button returns to the decision this review was opened from.
      .when(Boolean(this.back), (el) => el.on_mouse_down("back", () => openWorkflow(this.back.goalId, this.back.taskId)))
      .on_key_down((e, cx) => this.handleKey(e, cx))
      .on_key_up((e, cx) => this.escapeKey(e, cx))
      .child(this.header(t))
      .child(this.fileList(t))
      .when(Boolean(this.reading), (el) => el.child(this.description(t)))
      .when(!this.reading && Boolean(this.open), (el) => el.child(this.fileBar(t, font, mine)))
      .when(!this.reading, (el) => el.child(this.diff(t, font)))
      .when(!this.reading && Boolean(this.savedOpen) && mine.length > 0, (el) => el.child(this.savedStrip(t, font, mine)))
      .when(!this.reading && this.editing !== null, (el) => el.child(this.commentEditor(t, font)))
      // A run's change has no agent to send comments to.
      .when(!this.range, (el) => el.child(this.footer(t, agent, n, ready, mine)));
  }
}
