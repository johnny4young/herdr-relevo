import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, exec, notify, props, agents, panes, home, readTextFile, writeTextFile, openOverlay, closeOverlay } from "herdr";
import * as config from "./config.js";
import { ACCOUNTS } from "./accounts.js";
import { contextOfPath } from "./context.js";
import { historySuggestions, rankReplies, recordUse, normal } from "./lib/replies.js";

// Older config.js files have no REPLIES; a missing named import would stop the whole mod.
export const DEFAULT_REPLIES = ["Continue", "Tested and it works: commit and push", "Fix all of it"];
export const replies = () => (Array.isArray(config.REPLIES) ? config.REPLIES : DEFAULT_REPLIES);

const nameOf = (a) => a.tab_name || a.space_name || a.address;
const USAGE = ".local/state/relevo/replies.json";
const HOUR = 3600e3;

// Only short single-line prompts reach the parser; the history files run to megabytes.
const SHORT = 'for f; do [ -f "$f" ] && LC_ALL=C grep -E \'^\\{"display":"[^"\\\\/!\\[][^"\\\\]{5,160}",\' "$f"; done';
const suggested = new Map();

// Per context, so a work prompt never shows on a personal agent; read at most once an hour.
async function suggestionsFor(cwd) {
  const context = contextOfPath(cwd), hit = suggested.get(context);
  if (hit && Date.now() - hit.at < HOUR) return hit.list;
  const files = [...new Set(ACCOUNTS.filter((a) => a.claudeDir).map((a) => `${home()}/${a.claudeDir}/history.jsonl`))];
  const r = await exec("sh", ["-c", SHORT, "sh", ...files]);
  const list = historySuggestions(r.stdout ?? "", Date.now(), (project) => contextOfPath(project) === context);
  suggested.set(context, { at: Date.now(), list });
  return list;
}

async function readUsage() {
  const raw = await readTextFile(`${home()}/${USAGE}`).catch(() => null);
  try {
    return { raw, usage: JSON.parse(raw ?? "{}") ?? {} };
  } catch {
    return { raw, usage: {} };
  }
}

// Saved replies only: what you type stays out of the file. A lost race only loses one count.
async function countUse(text) {
  if (!replies().some((r) => normal(r) === normal(text))) return;
  const { raw, usage } = await readUsage();
  await writeTextFile(`${home()}/${USAGE}`, JSON.stringify(recordUse(usage, text, Date.now())), raw).catch(() => null);
}

export async function openReplies(address = agents().find((a) => a.focused)?.address) {
  const a = agents().find((x) => x.address === address);
  if (!a) return notify({ title: "No agent in focus", level: "info", timeout: 2000 });
  const cwd = panes().find((p) => p.pane === a.pane)?.cwd ?? a.cwd;
  const [{ usage }, history] = await Promise.all([readUsage(), suggestionsFor(cwd).catch(() => [])]);
  const list = rankReplies(replies(), usage, history, Date.now());
  openOverlay({
    mod: "relevo", kind: "dialog", width: 480, height: 92 + 30 * list.length,
    props: { role: "quick-replies", address: a.address, name: nameOf(a), replies: list },
  });
}

// Without --force, hc won't type into a question the agent is asking; a working agent queues the message.
export async function sendTo(address, name, text) {
  const r = await exec("hc", ["send", address, text]);
  if (r.code !== 0) {
    notify({ title: `Could not send to ${name}`, body: r.stderr.trim().split("\n")[0], level: "warning" });
    return false;
  }
  notify({ title: `Sent to ${name}`, body: text, level: "success", timeout: 2000 });
  await countUse(text);
  return true;
}

// The list holds the keyboard: ↑/↓ and Enter, or a reply's number. Typing moves to the field, which keeps the
// arrows for itself, so its Enter sends what was typed.
export class QuickReplies {
  init(_props, cx) {
    this.at = 0;
    this.h = cx.focus_handle();
    this.input = InputState.new({ value: "", placeholder: "Type to write a message" });
    this.input.on("change", (_e, cx) => cx.notify());
    this.input.on("submit", (_e, cx) => this.send(this.input.value().trim() || this.list()[this.at]?.text, cx));
    this.h.focus();
    cx.timer.after(300, () => {
      if (!this.input.value()) this.h.focus();
    });
  }

  close() {
    this.input.release();
  }

  list() {
    return props()?.replies ?? replies().map((text) => ({ text }));
  }

  send(text, cx) {
    const p = props();
    if (!text || this.sending) return;
    this.sending = true;
    cx.spawn(async () => {
      if (await sendTo(p.address, p.name, text)) closeOverlay(p.overlay);
      this.sending = false;
    });
  }

  key(e, cx) {
    const list = this.list().map((r) => r.text), n = list.length, held = e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt;
    if (e.key === "escape") return closeOverlay(props().overlay);
    if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
    else if (e.key === "enter") this.send(list[this.at], cx);
    else if (/^[1-9]$/.test(e.key) && !held && Number(e.key) <= n) this.send(list[Number(e.key) - 1], cx);
    else if (e.key === "tab") this.input.focus();
    else if (e.key_char && !held && e.key_char.trim()) {
      this.input.set_value(e.key_char);
      this.input.focus();
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  render() {
    const t = theme(), p = props(), typed = Boolean(this.input.value().trim());
    return v_flex().id("quick-replies").size_full().p(12).gap(8)
      .bg(t.popover ?? t.surface).text_color(t.foreground).text_size(13)
      .child(div().text_size(11).text_color(t.dim).truncate().child(`To ${p?.name ?? ""}`))
      .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(t.accent).bg(t.background))
      // Not around the field: its keys would reach this handler too.
      .child(v_flex().id("quick-replies-list").flex_none().track_focus(this.h).on_key_down((e, cx) => this.key(e, cx))
        .children(this.list().map(({ text, uses }, i) => h_flex().id(`reply-${i}`).h(30).px(8).gap(8).flex_none().items_center().rounded(6)
          .cursor_pointer()
          .when(i === this.at && !typed, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .when(Boolean(uses), (el) => el.tooltip(`From your history · ${uses} times`))
          .on_click((_e, cx) => this.send(text, cx))
          .child(div().w(10).flex_none().text_size(11).text_color(t.dim).child(i < 9 ? String(i + 1) : ""))
          .child(div().flex_1().min_w(0).truncate().child(text)))));
  }
}
