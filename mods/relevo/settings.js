import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, exec, appHome, props, openOverlay, closeOverlay } from "herdr";
import { ACCOUNTS, CODEX, CONTEXTS, FALLBACK, REPOS_ROOT, SKILLS } from "./config.js";
import * as config from "./config.js";
import { WRITE_SCRIPT, renderConfig, validate, slug, parseList, isHex } from "./lib/settings.js";
import { chip } from "./accounts.js";
import { replies } from "./replies.js";
import { button, spinner } from "./ui.js";

const COLORS = ["ansi2", "ansi4", "ansi5", "ansi6", "ansi3", "ansi1"];
const COLS = { label: 104, letter: 40, dir: 116, color: 76, ctxLabel: 140 };

export function openSettings() {
  openOverlay({ mod: "relevo", kind: "dialog", width: 800, height: 700, props: { role: "settings" } });
}

const text = (state) => state.value().trim();

// Writes config.js: its values are read at import time, and saving any file reloads the mod.
export class Settings {
  init(_props, _cx) {
    this.seq = 0;
    this.states = new Set();
    this.errors = [];
    this.accounts = ACCOUNTS.map((a) => this.accountRow(a));
    this.codex = this.input(CODEX.launcher, "codex");
    this.contexts = CONTEXTS.map((c) => this.contextRow(c));
    this.fallback = this.input(FALLBACK.join(", "), "personal, work");
    this.reposRoot = this.input(REPOS_ROOT, "code");
    this.backupsRoot = this.input(config.BACKUPS_ROOT ?? "relevo-backups", "relevo-backups");
    this.skills = Object.fromEntries(["review", "fix", "comments", "conflicts"].map((k) => [k, this.input(SKILLS[k] ?? "", k === "conflicts" ? "built-in prompt" : k)]));
    this.replies = replies().map((r) => this.replyRow(r));
  }

  replyRow(value = "") {
    return { id: ++this.seq, inputs: { text: this.input(value, "What to send the agent") } };
  }

  addReply(cx) {
    const row = this.replyRow();
    this.replies.push(row);
    row.inputs.text.focus();
    cx.notify();
  }

  removeReply(row, cx) {
    this.replies = this.replies.filter((r) => r !== row);
    this.drop(row);
    if (this.tried) this.errors = validate(this.collect());
    cx.notify();
  }

  input(value, placeholder) {
    const state = InputState.new({ value: value ?? "", placeholder });
    // Chips and keys preview as you type; after a failed save the errors follow the fixes.
    state.on("change", (_e, cx) => {
      if (this.tried) this.errors = validate(this.collect());
      cx.notify();
    });
    state.on("submit", (_e, cx) => this.save(cx));
    this.states.add(state);
    return state;
  }

  drop(row) {
    for (const s of Object.values(row.inputs)) {
      s.release();
      this.states.delete(s);
    }
  }

  accountRow(a = null) {
    const f = (k, p) => this.input(a?.[k], p);
    return {
      id: ++this.seq, orig: a,
      inputs: {
        label: f("label", "Label"), letter: f("letter", "L"), launcher: f("launcher", "claude"),
        claudeDir: f("claudeDir", ".claude"), bg: f("bg", "#82aaff"), fg: f("fg", "#1e2030"),
      },
    };
  }

  contextRow(c = null) {
    const used = new Set(this.contexts?.map((r) => r.color) ?? CONTEXTS.map((x) => x.color));
    return {
      id: ++this.seq, orig: c,
      color: c?.color ?? COLORS.find((x) => !used.has(x)) ?? COLORS[0],
      account: c ? this.accounts.find((r) => r.orig?.key === c.account) ?? null : this.accounts[0] ?? null,
      inputs: {
        label: this.input(c?.label, "Label"),
        orgs: this.input(c?.orgs?.join(", "), c === CONTEXTS[0] ? "default" : "GitHub orgs"),
      },
    };
  }

  // Existing keys stay stable: other files, folders and quota snapshots are named after them.
  keyOf(row) {
    return row.orig?.key ?? slug(text(row.inputs.label));
  }

  collect() {
    const contexts = this.contexts.map((r) => {
      const ctx = { ...r.orig, key: this.keyOf(r), label: text(r.inputs.label), account: r.account ? this.keyOf(r.account) : "" };
      ctx.color = r.color;
      delete ctx.orgs;
      const orgs = parseList(r.inputs.orgs.value());
      if (orgs.length) ctx.orgs = orgs;
      return ctx;
    });
    return {
      ACCOUNTS: this.accounts.map((r) => ({
        ...r.orig, key: this.keyOf(r),
        ...Object.fromEntries(Object.entries(r.inputs).map(([k, s]) => [k, text(s)])),
      })),
      CODEX: { ...CODEX, launcher: text(this.codex) },
      CONTEXTS: contexts,
      FALLBACK: parseList(this.fallback.value()),
      REPOS_ROOT: text(this.reposRoot),
      BACKUPS_ROOT: text(this.backupsRoot),
      SKILLS: Object.fromEntries(Object.entries(this.skills).map(([k, s]) => [k, text(s)]).filter(([k, v]) => k !== "conflicts" || v)),
      REPLIES: this.replies.map((r) => text(r.inputs.text)).filter(Boolean),
    };
  }

  addAccount(cx) {
    const row = this.accountRow();
    this.accounts.push(row);
    row.inputs.label.focus();
    cx.notify();
  }

  removeAccount(row, cx) {
    this.accounts = this.accounts.filter((r) => r !== row);
    for (const c of this.contexts) if (c.account === row) c.account = null;
    this.drop(row);
    if (this.tried) this.errors = validate(this.collect());
    cx.notify();
  }

  addContext(cx) {
    const row = this.contextRow();
    this.contexts.push(row);
    row.inputs.label.focus();
    cx.notify();
  }

  removeContext(row, cx) {
    this.contexts = this.contexts.filter((r) => r !== row);
    this.drop(row);
    if (this.tried) this.errors = validate(this.collect());
    cx.notify();
  }

  pickAccount(ctx, acct, cx) {
    ctx.account = acct;
    if (this.tried) this.errors = validate(this.collect());
    cx.notify();
  }

  save(cx) {
    if (this.saving) return;
    this.tried = true;
    this.errors = validate(this.collect());
    if (this.errors.length) return cx.notify();
    this.saving = true;
    cx.notify();
    const path = `${appHome()}/mods/relevo/config.js`;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", WRITE_SCRIPT, "sh", path, renderConfig({ ...config, ...this.collect() })])
        .catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code === 0) return closeOverlay(props()?.overlay);
      this.saving = false;
      this.errors = [{ at: "write", message: r.stderr.trim() || "Could not write config.js" }];
      cx.notify();
    });
  }

  close() {
    for (const s of this.states) s.release();
    this.states.clear();
  }

  bad(at) {
    return this.errors.some((e) => e.at === at);
  }

  field(t, id, state, at, width = 0) {
    return div().id(id).h(26).px(7).flex().items_center().rounded(6).border_1()
      .border_color(this.bad(at) ? t.blocked : t.input).bg(t.background).text_size(13)
      .when(width > 0, (el) => el.w(width).flex_none())
      .when(!width, (el) => el.flex_1().min_w(0))
      .child(Input.new(state).w_full());
  }

  labeled(t, label, el) {
    return v_flex().flex_1().min_w(0).gap(4)
      .child(div().text_size(11).text_color(t.dim).child(label))
      .child(h_flex().child(el));
  }

  section(t, id, title, prefixes, body) {
    const errors = this.errors.filter((e) => prefixes.some((p) => e.at === p || e.at.startsWith(`${p}.`)));
    return v_flex().id(id).flex_none().gap(6)
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(title))
      .children(body)
      .children(errors.map((e, i) => div().id(`${id}-error-${i}`).text_size(11).text_color(t.blocked).child(e.message)));
  }

  accountRowView(t, row, i) {
    const v = (k) => text(row.inputs[k]);
    const preview = {
      letter: v("letter") || "?", bg: isHex(v("bg")) ? v("bg") : t.raised, fg: isHex(v("fg")) ? v("fg") : t.foreground,
    };
    const at = (k) => `accounts.${i}.${k}`;
    return h_flex().id(`settings-account-${row.id}`).gap(6).items_center()
      .child(div().id(`settings-chip-${row.id}`).tooltip(this.keyOf(row) || "key from the label").child(chip(div, preview, 20)))
      .child(this.field(t, `sa-label-${row.id}`, row.inputs.label, this.bad(at("key")) ? at("key") : at("label"), COLS.label))
      .child(this.field(t, `sa-letter-${row.id}`, row.inputs.letter, at("letter"), COLS.letter))
      .child(this.field(t, `sa-launcher-${row.id}`, row.inputs.launcher, at("launcher")))
      .child(this.field(t, `sa-dir-${row.id}`, row.inputs.claudeDir, at("claudeDir"), COLS.dir))
      .child(this.field(t, `sa-bg-${row.id}`, row.inputs.bg, at("bg"), COLS.color))
      .child(this.field(t, `sa-fg-${row.id}`, row.inputs.fg, at("fg"), COLS.color))
      .child(button(t, `sa-remove-${row.id}`, "×", (cx) => this.removeAccount(row, cx),
        { size: "sm", tip: "Remove account", disabled: this.accounts.length < 2 }));
  }

  accountPicker(t, ctx, i) {
    return h_flex().id(`sc-account-${ctx.id}`).h(26).p(2).gap(2).flex_none().rounded(6).bg(t.raised).text_size(11)
      .when(this.bad(`contexts.${i}.account`), (el) => el.border_1().border_color(t.blocked))
      .children(this.accounts.map((acct) => div().id(`sc-account-${ctx.id}-${acct.id}`).h_full().px(7).flex().items_center()
        .rounded(4).cursor_pointer()
        .text_color(ctx.account === acct ? t.foreground : t.dim)
        .when(ctx.account === acct, (el) => el.bg(t.selected))
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => this.pickAccount(ctx, acct, cx))
        .child(text(acct.inputs.label) || "?")));
  }

  contextRowView(t, row, i) {
    const at = (k) => `contexts.${i}.${k}`;
    return h_flex().id(`settings-context-${row.id}`).gap(6).items_center()
      .child(div().size(8).flex_none().rounded(4).bg(t[row.color] ?? t.dim))
      .child(this.field(t, `sc-label-${row.id}`, row.inputs.label, at("label"), COLS.ctxLabel))
      .child(this.accountPicker(t, row, i))
      .child(this.field(t, `sc-orgs-${row.id}`, row.inputs.orgs, at("orgs")))
      .child(button(t, `sc-remove-${row.id}`, "×", (cx) => this.removeContext(row, cx),
        { size: "sm", tip: "Remove context", disabled: this.contexts.length < 2 }));
  }

  render() {
    const t = theme();
    const head = (cells) => h_flex().gap(6).text_size(11).text_color(t.dim)
      .children(cells.map(([label, w]) => div()
        .when(w > 0, (el) => el.w(w).flex_none())
        .when(!w, (el) => el.flex_1())
        .child(label)));
    const keys = this.accounts.map((r) => this.keyOf(r)).filter(Boolean).join(", ");
    const body = v_flex().id("settings-body").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(14).gap(18)
      .child(this.section(t, "settings-accounts", "ACCOUNTS", ["accounts"], [
        head([["", 20], ["Label", COLS.label], ["Letter", COLS.letter], ["Launcher", 0], ["Claude dir", COLS.dir],
          ["Background", COLS.color], ["Text", COLS.color], ["", 20]]),
        ...this.accounts.map((r, i) => this.accountRowView(t, r, i)),
        h_flex().child(button(t, "settings-add-account", "+ Account", (cx) => this.addAccount(cx), { size: "sm" })),
      ]))
      .child(this.section(t, "settings-codex", "CODEX", ["codex"], [
        this.labeled(t, "Launcher", this.field(t, "settings-codex-launcher", this.codex, "codex.launcher")),
      ]))
      .child(this.section(t, "settings-contexts", "CONTEXTS", ["contexts"], [
        ...this.contexts.map((r, i) => this.contextRowView(t, r, i)),
        h_flex().child(button(t, "settings-add-context", "+ Context", (cx) => this.addContext(cx), { size: "sm" })),
      ]))
      .child(this.section(t, "settings-folders", "FALLBACK AND FOLDERS", ["fallback", "reposRoot", "backupsRoot"], [
        h_flex().gap(12)
          .child(this.labeled(t, `Fallback order · ${keys}`, this.field(t, "settings-fallback", this.fallback, "fallback")))
          .child(this.labeled(t, "Repos root under home", this.field(t, "settings-repos-root", this.reposRoot, "reposRoot")))
          .child(this.labeled(t, "Backups under home", this.field(t, "settings-backups-root", this.backupsRoot, "backupsRoot"))),
      ]))
      .child(this.section(t, "settings-skills", "SKILLS", ["skills"], [
        h_flex().gap(12).children([["review", "Review"], ["fix", "CI fix"], ["comments", "Review comments"], ["conflicts", "Merge conflicts"]].map(([k, label]) =>
          this.labeled(t, label, this.field(t, `settings-skill-${k}`, this.skills[k], `skills.${k}`)))),
      ]))
      .child(this.section(t, "settings-replies", "QUICK REPLIES", ["replies"], [
        ...this.replies.map((r) => h_flex().id(`settings-reply-${r.id}`).gap(6).items_center()
          .child(this.field(t, `sr-text-${r.id}`, r.inputs.text, "replies"))
          .child(button(t, `sr-remove-${r.id}`, "×", (cx) => this.removeReply(r, cx), { size: "sm", tip: "Remove reply" }))),
        h_flex().child(button(t, "settings-add-reply", "+ Reply", (cx) => this.addReply(cx), { size: "sm" })),
      ]));
    const failed = this.errors.find((e) => e.at === "write");
    const footer = h_flex().h(48).flex_none().px(16).gap(8).items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(11)
        .when(Boolean(failed), (el) => el.text_color(t.blocked).child(failed?.message ?? ""))
        .when(!failed && this.errors.length > 0, (el) => el.text_color(t.blocked)
          .child(`${this.errors.length} to fix before saving`)))
      .when(Boolean(this.saving), (el) => el.child(spinner(t.dim)))
      .child(button(t, "settings-cancel", "Cancel", () => closeOverlay(props()?.overlay), { size: "lg" }))
      .child(button(t, "settings-save", "Save", (cx) => this.save(cx),
        { kind: "solid", size: "lg", disabled: Boolean(this.saving) }));
    return v_flex().id("settings").size_full().bg(t.popover ?? t.surface).text_color(t.foreground)
      .child(h_flex().h(44).flex_none().px(16).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(13).child("Relevo settings")))
      .child(body)
      .child(footer);
  }
}
