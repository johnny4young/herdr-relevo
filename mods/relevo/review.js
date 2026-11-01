import { div, list } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, Scrollbar } from "gpui-base";
import { theme, exec, run, agents, panes, focused, props, settings, notify, shared, setShared } from "herdr";
import { focusedCwd } from "./panelbar.js";
import { button } from "./ui.js";
import { diffRows, lineKey } from "./lib/diff.js";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const MAX_ROWS = 4000;
// Open review panes by checkout, so a second Review focuses the first.
const OPEN = "relevo.reviews";
// Unsent comments by checkout, so closing the pane or Herdr doesn't lose them.
const NOTES = "relevo.review.notes";

// An agent whose pane sits in this checkout; the one that made the changes is usually the only one.
function agentIn(root) {
  const byPane = new Map(panes().map((p) => [p.pane, p.cwd]));
  return agents().find((a) => {
    const cwd = byPane.get(a.pane) ?? "";
    return cwd === root || cwd.startsWith(`${root}/`);
  }) ?? null;
}

export async function openReview(root = focusedCwd(), terminal = null) {
  if (!root) return;
  const top = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: root })).stdout.trim();
  if (!top) return notify({ title: "Not a git repository", level: "info" });
  const pane = shared(OPEN)?.[top];
  if (pane && panes().some((p) => p.pane === pane)) return run("pane.focus", { pane });
  run("pane.split", { direction: "right", mod: "relevo", props: { role: "review-diff", root: top, terminal } });
}

// Entries whose pane is gone drop out on the next write.
const live = () => Object.fromEntries(
  Object.entries(shared(OPEN) ?? {}).filter(([, pane]) => panes().some((p) => p.pane === pane)),
);

export class ReviewDiff {
  init(_props, cx) {
    const p = props() ?? {};
    this.root = p.root ?? null;
    this.terminal = p.terminal ?? null;
    this.files = [];
    this.rows = [];
    this.comments = shared(NOTES)?.[this.root] ?? [];
    this.editing = null;
    this.input = InputState.new({ value: "", placeholder: "Comment for the agent · Enter saves, Esc cancels" });
    this.input.on("submit", (_e, cx) => this.save(cx));
    if (this.root) this.load(cx);
    // The agent keeps working while you read; pick up its changes unless you are typing.
    cx.timer.every(10000, (cx) => {
      if (this.editing === null && !this.loading) this.load(cx);
    });
    // The split focuses the new pane, which is how this view learns its own id.
    cx.timer.after(300, () => {
      const pane = focused()?.pane;
      if (!this.root || !pane || panes().find((x) => x.pane === pane)?.mod !== "relevo") return;
      this.pane = pane;
      setShared(OPEN, { ...live(), [this.root]: pane });
    });
  }

  close() {
    this.input.release();
    if (this.pane && shared(OPEN)?.[this.root] === this.pane) {
      const { [this.root]: _, ...rest } = live();
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

  async read(cx) {
    const git = (args) => exec("git", [...READ, ...args], { cwd: this.root });
    const tracked = (await git(["diff", "HEAD", "--numstat", "--no-renames"])).stdout.split("\n").filter(Boolean)
      .map((l) => {
        const [add, del, path] = l.split("\t");
        return { path, add: +add || 0, del: +del || 0 };
      });
    const untracked = (await git(["ls-files", "--others", "--exclude-standard"])).stdout.split("\n").filter(Boolean)
      .map((path) => ({ path, add: 0, del: 0, untracked: true }));
    const files = [...tracked, ...untracked], sign = JSON.stringify(files);
    if (sign !== this.filesSign) {
      this.filesSign = sign;
      this.files = files;
      cx.notify();
    }
    const open = files.find((f) => f.path === this.open?.path) ?? files[0];
    if (open) await this.pick(open, cx);
    else this.rows = [];
  }

  async pick(file, cx) {
    if (this.open?.path !== file.path) {
      this.editing = null;
      this.diffSign = null;
    }
    this.open = file;
    const args = file.untracked
      ? ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", file.path]
      : ["diff", "HEAD", "--no-color", "--no-ext-diff", "--", file.path];
    const out = (await exec("git", [...READ, ...args], { cwd: this.root })).stdout;
    if (out === this.diffSign) return;
    this.diffSign = out;
    this.rows = diffRows(out.split("\n")).slice(0, MAX_ROWS);
    cx.notify();
  }

  edit(i, cx) {
    if (this.editing === i || this.rows[i]?.number === undefined) return;
    this.editing = i;
    const key = lineKey(this.rows[i]);
    this.input.set_value(this.comments.find((c) => c.file === this.open.path && c.key === key)?.text ?? "");
    this.input.focus();
    cx.notify();
  }

  save(cx) {
    const text = this.input.value().trim(), row = this.rows[this.editing];
    if (!row) {
      this.editing = null;
      return cx.notify();
    }
    const key = lineKey(row);
    const kept = this.comments.filter((c) => !(c.file === this.open.path && c.key === key));
    const added = text ? [{ file: this.open.path, key, line: row.number, side: row.kind, code: row.text.trim(), text }] : [];
    this.setComments([...kept, ...added]);
    this.editing = null;
    cx.notify();
  }

  setComments(list) {
    this.comments = list;
    this.clearing = false;
    const all = { ...(shared(NOTES) ?? {}) };
    if (list.length) all[this.root] = list;
    else delete all[this.root];
    setShared(NOTES, all);
  }

  target() {
    return this.terminal ? agents().find((a) => a.address === this.terminal) ?? null : agentIn(this.root);
  }

  send(cx) {
    const agent = this.target();
    if (!agent || !this.comments.length) return;
    const items = this.comments.map((c, i) => [
      `${i + 1}. ${c.file}:${c.line}${c.side === "-" ? " (removed line)" : ""}`,
      `   > ${c.code.slice(0, 160)}`,
      `   ${c.text}`,
    ].join("\n"));
    const message = `Review comments on the uncommitted changes. Address each one, then summarize what you changed.\n\n${items.join("\n\n")}`;
    cx.spawn(async (cx) => {
      const r = await exec("hc", ["send", agent.address, message]);
      if (r.code !== 0) this.note = r.stderr.trim().split("\n")[0] || "hc send failed";
      else {
        this.setComments([]);
        this.note = `Sent to ${agent.tab_name || agent.address}`;
        run("agent.focus", { terminal: agent.address });
      }
      cx.notify();
    });
  }

  key(e, cx) {
    if (e.key === "escape" && this.editing !== null) {
      this.editing = null;
      cx.stop_propagation();
      cx.notify();
    }
  }

  // Runs inside the virtual list: no handlers here, clicks go through on_item_click.
  row(t, r, i, note, font) {
    const line = r.kind === "@"
      ? div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(r.text)
      : h_flex().w_full().h(20).flex_none().gap(10).cursor_pointer().hover((s) => s.bg(t.hover))
        .when(r.kind === "+", (e) => e.bg(t.ansi2 + "18"))
        .when(r.kind === "-", (e) => e.bg(t.ansi1 + "18"))
        .child(div().w(30).flex_none().text_right().text_color(note ? t.accent : t.dim).child(note ? "●" : String(r.number)))
        .child(div().flex_1().min_w(0).truncate().child(r.text));
    if (this.editing === i) {
      return v_flex().w_full().flex_none()
        .child(line)
        .child(div().mx(10).my(4).h(30).px(8).flex().items_center()
          .rounded(6).border_1().border_color(t.accent).bg(t.background)
          .font_family(font).text_size(12)
          .child(Input.new(this.input).h_full()));
    }
    if (!note) return line;
    return v_flex().w_full().flex_none()
      .child(line)
      .child(div().mx(10).my(3).px(8).py(4).rounded(6).bg(t.raised).cursor_pointer()
        .font_family(font).text_size(11.5).text_color(t.foreground)
        .child(note.text));
  }

  header(t) {
    return h_flex().h(34).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child("Review"))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim)
        .child(this.root?.split("/").pop() ?? "No folder"))
      .child(div().text_size(11).text_color(t.muted).child("Click a line to comment"));
  }

  fileList(t) {
    return v_flex().id("rv-files").flex_none().max_h(150).overflow_y_scrollbar().p(4).border_b(1).border_color(t.border)
      .when(!this.files.length, (el) => el.child(div().p(8).text_color(t.dim).child("No uncommitted changes")))
      .children(this.files.map((f) => {
        const count = this.comments.filter((c) => c.file === f.path).length;
        return h_flex().id(`rv-file-${f.path}`).h(24).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .when(this.open?.path === f.path, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => cx.spawn(async (cx) => {
            await this.pick(f, cx);
          }))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).child(f.path))
          .when(count > 0, (el) => el.child(div().text_size(10.5).text_color(t.accent).child(`● ${count}`)))
          .when(f.untracked, (el) => el.child(div().text_size(10.5).text_color(t.ansi2).child("new")))
          .when(!f.untracked, (el) => el
            .child(div().text_size(10.5).text_color(t.ansi2).child(`+${f.add}`))
            .child(div().text_size(10.5).text_color(t.ansi1).child(`−${f.del}`)));
      }));
  }

  diff(t, notes, font) {
    const row = (i) => this.row(
      t, this.rows[i], i, this.rows[i].number === undefined ? null : notes.get(lineKey(this.rows[i])), font,
    );
    return div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
      .child(list("rv-diff", this.rows.length, (i) => String(i), row)
        .size_full()
        .on_item_click((key, cx) => this.edit(+key, cx)))
      .child(Scrollbar.vertical("rv-diff").absolute().inset_0());
  }

  footer(t, agent, n, ready) {
    return h_flex().h(44).flex_none().px(10).gap(8).items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted)
        .child(this.note ?? (agent
          ? `${n} ${n === 1 ? "comment" : "comments"} for ${agent.tab_name || agent.address}`
          : "No agent in this folder")))
      .when(n > 0, (el) => el.child(button(t, "rv-clear", this.clearing ? "Confirm" : "Clear", (cx) => {
        if (this.clearing) this.setComments([]);
        else this.clearing = true;
        cx.notify();
      }, { size: "lg", kind: this.clearing ? "danger" : "outline" })))
      .child(button(t, "rv-send", "Send to agent", (cx) => this.send(cx), { kind: "solid", size: "lg", disabled: !ready }));
  }

  render() {
    const t = theme(), agent = this.target(), n = this.comments.length, ready = Boolean(agent && n);
    const notes = new Map(this.comments.filter((c) => c.file === this.open?.path).map((c) => [c.key, c]));
    const font = settings().ui_font_family ?? "Inter";
    return v_flex().id("relevo-review").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => this.key(e, cx))
      .child(this.header(t))
      .child(this.fileList(t))
      .child(this.diff(t, notes, font))
      .child(this.footer(t, agent, n, ready));
  }
}
