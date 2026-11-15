import { div, list } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, Scrollbar } from "gpui-base";
import { theme, exec, run, agents, panes, focused, props, settings, notify, shared, setShared, window } from "herdr";
import { focusedCwd } from "./panelbar.js";
import { button, checkbox, icon, tag, diffRatio, keycap } from "./ui.js";
import { ago } from "./lib/time.js";
import { launchInRepo } from "./accounts.js";
import { accountFor } from "./context.js";
import { baseBranch } from "./worktrees.js";
import { openWorkflow } from "./workflow-window.js";
import { GIT_READ as READ } from "./lib/git.js";
import { diffRows, lineKey, selectRange, lineComment, fileComment, commentId, commentLabel, rangeRows, reviewMessage } from "./lib/diff.js";

const MAX_ROWS = 4000;
// Open review panes by checkout, so a second Review focuses the first.
const OPEN = "relevo.reviews";
// Unsent comments by checkout, so closing the pane or Herdr doesn't lose them.
const NOTES = "relevo.review.notes";
// What the review showed when marked seen, by checkout or PR: { tree, at }.
const SEEN = "relevo.review.seen";
// Files marked viewed, by checkout or PR: path -> the content's hash then, so a change unmarks it.
const VIEWED = "relevo.review.viewed";
// The working tree as a git tree, untracked files in and ignored ones out, built in a scratch index. cp -p keeps
// the index's time, which git needs to notice a same-size edit made in the second the index was written.
const SNAPSHOT = 'i=$(mktemp) || exit 1; cp -p "$(git rev-parse --git-path index)" "$i" 2>/dev/null || rm -f "$i"; '
  + 'GIT_INDEX_FILE="$i" git add -A . >/dev/null 2>&1 && GIT_INDEX_FILE="$i" git write-tree; s=$?; rm -f "$i"; exit $s';
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
const MAX_HASHED = 300;
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
export async function openReview(root = focusedCwd(), terminal = null, pr = null, back = null) {
  if (!root) return;
  const top = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: root })).stdout.trim();
  if (!top) return notify({ title: "Not a git repository", level: "info" });
  const pane = shared(OPEN)?.[reviewKey(top, pr)];
  if (pane && panes().some((p) => p.pane === pane)) return run("pane.focus", { pane });
  run("pane.split", { direction: "right", mod: "relevo", props: { role: "review-diff", root: top, terminal, pr, ...(back ? { back } : {}) } });
}

const reviewKey = (root, pr) => (pr ? `${root}#${pr.number}` : root);

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
  { id: "review.send", label: "Send the comments to the agent", section: "Review pane", fixedShortcut: "cmd-enter" },
];

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
    // Open panes and unsent comments are kept per checkout, and per PR when reviewing one.
    this.key = reviewKey(this.root, this.pr);
    // Without a PR: "uncommitted", or "all" for the branch's commits too; "pr" with one; "seen" since the mark.
    this.scope = this.pr ? "pr" : "uncommitted";
    this.hashes = new Map();
    this.files = [];
    this.rows = [];
    this.comments = shared(NOTES)?.[this.key] ?? [];
    // null, { start, end } row indices, or "file".
    this.editing = null;
    this.anchor = null;
    this.input = InputState.new({ value: "", placeholder: "Comment for the agent · Enter saves, Esc cancels" });
    this.input.on("submit", (_e, cx) => this.save(cx));
    if (this.root) this.load(cx);
    // The agent keeps working while you read; pick up its changes unless you are typing.
    // Behind another app nobody reads it, so it waits until the window is back.
    cx.timer.every(10000, (cx) => {
      if (this.editing === null && !this.loading && window()?.active !== false) this.load(cx);
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
    if (this.scope === "seen") return this.seenMark()?.tree ?? "HEAD";
    if (!this.pr && this.scope !== "all") return "HEAD";
    if (!this.mergeBase) {
      const remote = this.pr ? await git(["rev-parse", "--verify", "--quiet", `origin/${this.pr.base}`]) : null;
      const base = this.pr ? (remote.code === 0 ? `origin/${this.pr.base}` : this.pr.base) : await baseBranch(this.root);
      this.baseName = base;
      this.mergeBase = base ? (await git(["merge-base", base, this.pr?.ref ?? "HEAD"])).stdout.trim() : "";
    }
    return this.mergeBase || "HEAD";
  }

  setScope(scope, cx) {
    if (scope === this.scope) return;
    Object.assign(this, { scope, mergeBase: null, filesSign: null, diffSign: null, editing: null, anchor: null });
    this.load(cx);
    cx.notify();
  }

  async read(cx) {
    const git = (args) => exec("git", [...READ, ...args], { cwd: this.root }), scope = this.scope;
    const from = await this.since(git);
    if (scope !== this.scope) return;
    this.from = from;
    // Since the mark, both sides are trees: the seen one and the working tree now, untracked files included.
    this.to = scope === "seen" ? await this.snapshot() || null : this.pr?.ref ?? null;
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
    if (open) await this.pick(open, cx);
    else Object.assign(this, { rows: [], open: null, diffSign: null });
  }

  async pick(file, cx) {
    if (this.open?.path !== file.path) {
      this.editing = null;
      this.anchor = null;
      this.diffSign = null;
    }
    this.open = file;
    const args = file.untracked
      ? ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", file.path]
      : ["diff", this.from ?? "HEAD", ...(this.to ? [this.to] : []), "--no-color", "--no-ext-diff", "--", file.path];
    const out = (await exec("git", [...READ, ...args], { cwd: this.root })).stdout;
    if (out === this.diffSign) return;
    this.diffSign = out;
    this.anchor = null;
    this.rows = diffRows(out.split("\n")).slice(0, MAX_ROWS);
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
    setShared(SEEN, { ...(shared(SEEN) ?? {}), [this.key]: { tree, at: Math.round(Date.now() / 1000) } });
    cx.notify();
  }

  viewed(path) {
    const hash = this.hashes.get(path);
    return Boolean(hash) && shared(VIEWED)?.[this.key]?.[path] === hash;
  }

  toggleViewed(path, cx) {
    if (!this.hashes.get(path)) return;
    const all = { ...(shared(VIEWED) ?? {}) }, mine = { ...(all[this.key] ?? {}) };
    if (this.viewed(path)) delete mine[path];
    else mine[path] = this.hashes.get(path);
    // Only files still in the review keep their mark, so the list doesn't grow.
    const listed = new Set(this.files.map((f) => f.path));
    all[this.key] = Object.fromEntries(Object.entries(mine).filter(([p]) => listed.has(p)));
    setShared(VIEWED, all);
    cx.notify();
  }

  markAllViewed(cx) {
    const mine = Object.fromEntries(this.files.flatMap(({ path }) => this.hashes.get(path) ? [[path, this.hashes.get(path)]] : []));
    setShared(VIEWED, { ...(shared(VIEWED) ?? {}), [this.key]: mine });
    cx.notify();
  }

  subject() {
    if (this.scope === "seen") return `what changed since I last looked${this.pr ? ` at PR #${this.pr.number} (${this.pr.url})` : ""}`;
    if (!this.pr) return this.scope === "all" && this.mergeBase ? `the branch against ${this.baseName}, committed and uncommitted` : undefined;
    const where = this.pr.ref ? `; it is not checked out here, so work on it in a worktree (gh pr checkout ${this.pr.number})` : "";
    return `PR #${this.pr.number} (${this.pr.url}), the branch against ${this.pr.base}${where}`;
  }

  target() {
    return this.terminal ? agents().find((a) => a.address === this.terminal) ?? null : agentIn(this.root);
  }

  ready(agent = this.target()) {
    return Boolean((agent || this.pr) && this.comments.length && this.editing === null && !this.sending);
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

  escapeKey(e, cx) {
    if (e.key !== "escape" || this.editing === null) return false;
    cx.stop_propagation();
    this.cancelEdit(cx);
    return true;
  }

  // ⌘↵ is the Send button and waits for the same things; a held key repeats, and one press sends once.
  handleKey(e, cx) {
    if (this.escapeKey(e, cx) || this.paneKey(e, cx)) return;
    if (!sendChord(e) || e.is_held || !this.ready()) return;
    cx.stop_propagation();
    this.send(cx);
  }

  // While no comment is open: c comments on the file, v marks it viewed, [ and ] go to the previous or next file.
  paneKey(e, cx) {
    const m = e.modifiers ?? {};
    if (this.editing !== null || m.platform || m.control || m.alt || !this.open) return false;
    const at = (this.files ?? []).indexOf(this.open), step = e.key === "[" ? -1 : e.key === "]" ? 1 : 0;
    if (e.key === "c") this.edit("file", cx);
    else if (e.key === "v" && this.hashes?.get(this.open.path)) this.toggleViewed(this.open.path, cx);
    else if (step && this.files[at + step]) cx.spawn(async (cx) => { await this.pick(this.files[at + step], cx); });
    else return false;
    cx.stop_propagation();
    return true;
  }

  // Runs inside the virtual list: no handlers here, clicks go through on_item_click.
  row(t, r, i, noted, tint) {
    const e = this.editing, marked = onRows(e) && i >= e.start && i <= e.end;
    if (r.kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(r.text);
    return h_flex().w_full().h(20).flex_none().gap(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .when(r.kind === "+", (el) => el.bg(t.ansi2 + "18"))
      .when(r.kind === "-", (el) => el.bg(t.ansi1 + "18"))
      .when(tint && !marked, (el) => el.bg(t.accent + "1f"))
      .when(marked, (el) => el.bg(t.selected))
      .child(div().w(30).flex_none().text_right().text_color(noted ? t.accent : t.dim).child(String(r.number)))
      .child(h_flex().w(12).flex_none().when(noted, (el) => el.child(icon("comment", t.accent))))
      .child(div().flex_1().min_w(0).truncate().child(r.text));
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
    return v_flex().flex_none().px(12).py(6).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
      .when(Boolean(this.back), (el) => el.child(button(t, "rv-back-decision", "← Back to decision", () => openWorkflow(this.back.goalId, this.back.taskId), { size: "sm" })))
      .child(div().font_semibold().child("Review"))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
        .child(this.pr
          ? `${this.pr.repo.split("/")[1]} #${this.pr.number} · against ${this.pr.base}`
          : `${this.root?.split("/").pop() ?? "No folder"}${this.scope === "all" && this.mergeBase ? ` · against ${this.baseName}` : ""}`)))
      .child(h_flex().flex_wrap().gap(8).items_center()
      .when(!this.pr || Boolean(this.seenMark()), (el) => el.child(this.scopePicker(t)))
      .when(this.files.length > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim)
        .child(`${this.files.filter((f) => this.viewed(f.path)).length} of ${this.files.length} viewed`)))
      .child(button(t, "rv-mark-all-viewed", "Mark all viewed", (cx) => this.markAllViewed(cx),
        { size: "sm", disabled: !this.files.some((f) => this.hashes.get(f.path) && !this.viewed(f.path)), tip: "Mark every file in this review as viewed. Changed files become unviewed again." }))
      .child(button(t, "rv-mark-seen", "Save checkpoint", (cx) => cx.spawn(async (cx) => {
        await this.markSeen(cx);
      }), { size: "sm", tip: "Set the baseline for Since I looked. This does not mark files viewed. Sending comments saves a checkpoint too." })));
  }

  scopePicker(t) {
    const tips = { pr: "Review the entire PR against its base", uncommitted: "Review working tree changes, including new files",
      all: "Review committed and uncommitted changes against the branch base", seen: "Review changes since your last saved checkpoint" };
    const pick = (scope, label) => button(t, `rv-scope-${scope}`, label, (cx) => this.setScope(scope, cx),
      { size: "sm", selected: this.scope === scope, kind: this.scope === scope ? "solid" : "outline", tip: tips[scope] });
    const options = this.pr ? [["pr", "Whole PR"]] : [["uncommitted", "Uncommitted"], ["all", "All changes"]];
    if (this.seenMark()) options.push(["seen", "Since I looked"]);
    return h_flex().id("rv-scope").flex_wrap().min_w(0).p(1).gap(3).rounded(5).bg(t.raised)
      .children(options.map(([scope, label]) => pick(scope, label)));
  }

  empty() {
    if (this.scope === "seen") return `Nothing changed since you looked, ${ago(this.seenMark()?.at ?? 0)}`;
    if (this.scope !== "all") return "No uncommitted changes";
    return this.mergeBase ? `No changes against ${this.baseName}` : "No base branch to compare with";
  }

  // Outside the virtual list, so ordinary handlers work here.
  fileBar(t, font, mine) {
    const note = mine.find((c) => c.scope === "file");
    return v_flex().flex_none().border_b(1).border_color(t.border)
      .child(h_flex().min_h(30).px(12).gap(8).flex_wrap().items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.open.path))
        .child(button(t, "rv-file-viewed", this.viewed(this.open.path) ? "Mark unviewed" : "Mark file viewed", (cx) => this.toggleViewed(this.open.path, cx),
          { size: "sm", disabled: !this.hashes.get(this.open.path), tip: "Change the viewed status of the selected file" }))
        .child(button(t, "rv-file-comment", "Comment on file", (cx) => this.edit("file", cx), { size: "sm" })))
      .when(Boolean(note) && this.editing !== "file", (el) => el.child(this.noteBox(t, note, font)
        .id("rv-file-note")
        .on_click((_e, cx) => this.edit("file", cx))));
  }

  fileList(t) {
    const counts = new Map();
    for (const c of this.comments) counts.set(c.file, (counts.get(c.file) ?? 0) + 1);
    return v_flex().id("rv-files").flex_none().h(Math.min(150, Math.max(40, this.files.length * 24 + 9))).overflow_y_scrollbar().p(4).border_b(1).border_color(t.border)
      .when(!this.files.length, (el) => el.child(div().p(8).text_color(t.dim).child(this.pr ? "No changes" : this.empty())))
      .children(this.files.map((f) => {
        const count = counts.get(f.path) ?? 0;
        const seen = this.viewed(f.path), cut = f.path.lastIndexOf("/") + 1;
        return h_flex().id(`rv-file-${f.path}`).h(24).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .when(this.open?.path === f.path, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => cx.spawn(async (cx) => {
            await this.pick(f, cx);
          }))
          .child(button(t, `rv-viewed-${f.path}`, [checkbox(t, seen)], (cx) => this.toggleViewed(f.path, cx),
            { size: "sm", selected: seen, disabled: !this.hashes.get(f.path), accessibleLabel: `${seen ? "Mark unviewed" : "Mark viewed"}: ${f.path}`, tip: "Viewed files become unviewed if their contents change" }))
          .child(h_flex().flex_1().min_w(0).gap(2).items_baseline().overflow_hidden()
            .when(cut > 0, (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(f.path.slice(0, cut))))
            .child(div().flex_none().text_size(13).text_color(seen ? t.dim : t.foreground).child(f.path.slice(cut))))
          .when(count > 0, (el) => el.child(tag(t, icon("comment", t.accent, 10)).id(`rv-count-${f.path}`).gap(3).child(String(count))))
          .when(Boolean(f.added), (el) => el.child(tag(t, "new", t.ansi2).id(`rv-tag-new-${f.path}`)))
          .when(Boolean(f.binary), (el) => el.child(tag(t, "binary", t.muted).id(`rv-tag-binary-${f.path}`)))
          .when(!f.untracked && !f.binary, (el) => el
            .when(f.add > 0 || !f.del, (n) => n.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
            .when(f.del > 0, (n) => n.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))
            .child(diffRatio(t, f.add, f.del)));
      }));
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
    const { items, starts, tinted } = this.diffModel();
    const isRow = (n) => typeof items[n] === "number";
    const key = (n) => (isRow(n) ? String(items[n]) : `c:${commentId(items[n])}`);
    const item = (n) => {
      if (!isRow(n)) return this.noteBox(t, items[n], font);
      const i = items[n], r = this.rows[i];
      return this.row(t, r, i, r.number !== undefined && starts.has(lineKey(r)), tinted.has(i));
    };
    return div().id("rv-diff-area").flex_1().min_h(0).relative()
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
      .on_mouse_down("left", (e) => {
        this.shift = e.modifiers.shift;
      })
      .child(list("rv-diff", items.length, key, item)
        .size_full()
        .on_item_click((id, cx) => (id.startsWith("c:") ? this.clickNote(id.slice(2), cx) : this.clickRow(+id, cx))))
      .child(Scrollbar.vertical("rv-diff").absolute().inset_0());
  }

  footer(t, agent, n, ready) {
    return h_flex().h(44).flex_none().px(10).gap(8).items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted)
        .child(this.note ?? (agent
          ? `${n} ${n === 1 ? "comment" : "comments"} for ${agent.tab_name || agent.address}`
          : this.pr ? "A new agent will take them" : "No agent in this folder")))
      .when(n > 0, (el) => el.child(button(t, "rv-clear", this.clearing ? "Confirm" : "Clear", (cx) => {
        if (this.clearing) this.setComments([]);
        else this.clearing = true;
        cx.notify();
      }, { size: "lg", kind: this.clearing ? "danger" : "outline" })))
      .child(h_flex().id("rv-send-key").flex_none().gap(2).child(keycap(t, "⌘")).child(keycap(t, "enter")))
      .child(button(t, "rv-send", "Send to agent", (cx) => this.send(cx), { kind: "solid", size: "lg", disabled: !ready,
        tip: this.editing !== null ? "Save or cancel the current edit before sending comments" : "Send saved review comments to the agent · ⌘↵" }));
  }

  render() {
    const t = theme(), agent = this.target(), n = this.comments.length, ready = this.ready(agent);
    const font = settings().ui_font_family ?? "Inter", mine = this.comments.filter((c) => c.file === this.open?.path);
    return v_flex().id("relevo-review").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.focus)
      .on_mouse_down("left", () => { if (this.editing === null) this.focus.focus(); })
      .on_key_down((e, cx) => this.handleKey(e, cx))
      .on_key_up((e, cx) => this.escapeKey(e, cx))
      .child(this.header(t))
      .child(this.fileList(t))
      .when(Boolean(this.open), (el) => el.child(this.fileBar(t, font, mine)))
      .child(this.diff(t, font))
      .when(mine.length > 0, (el) => el.child(this.savedStrip(t, font, mine)))
      .when(this.editing !== null, (el) => el.child(this.commentEditor(t, font)))
      .child(this.footer(t, agent, n, ready));
  }
}
