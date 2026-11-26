// Waiting-agent prompt cards, numbered answers, notes and free-text replies. Mixed into Inbox.
import { div } from "gpui-kit";
import { h_flex, v_flex, Input } from "gpui-base";
import { agents, exec, home, notify, settings, shared, terminals } from "herdr";
import { ago } from "./lib/time.js";
import { ASKS_DIR, parseNotes } from "./lib/asks.js";
import { readPrompt, samePrompt, sameChoicesBut, submitKeys, freeOption, moveKeys, reasonOf } from "./lib/prompt.js";
import { button, checkbox, icon, keycap } from "./ui.js";

const SETTLE_TRIES = 8;
const SEND_STALE = 20000;
const NEXT_FOR = 8000;
const ASK_LINES = 8;
const REASONS = "relevo.reasons";
const hc = (args) => exec("hc", args);

export class PromptViews {
  // Long lines wrap: a cut command could hide the part that matters.
  askBlock(t, ask, address) {
    const head = [ask.title, ask.about].filter(Boolean).join(" · "), key = `ask-${address}`;
    const more = this.expanded[key] ? 0 : ask.body.length - ASK_LINES;
    const mono = (el) => el.font_family(settings().font_family ?? "JetBrains Mono").text_size(11);
    return v_flex().gap(3)
      .when(Boolean(head), (el) => el.child(div().text_size(11).text_color(t.muted).child(head)))
      .when(ask.body.length > 0, (el) => el.child(mono(v_flex().min_w(0).px(8).py(5).rounded(6).bg(t.raised).text_color(t.foreground))
        .when(Boolean(ask.cut), (b) => b.child(div().text_color(t.dim).child("… starts above the screen")))
        .children((more > 0 ? ask.body.slice(0, ASK_LINES) : ask.body).map((l) => div().min_w(0).child(l)))
        .when(more > 0, (b) => b.child(div().id(`${key}-more`).cursor_pointer().text_color(t.accent)
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.expanded[key] = true;
            cx.notify();
          })
          .child(`+${more} more ${more === 1 ? "line" : "lines"}`)))));
  }

  // A waiting agent: its question, the command or plan it asks about, and its numbered answers stay in
  // sight, since answering without them is unsafe. A click answers (or checks, in a multiple choice).
  waitingCard(t, item) {
    const a = item.agent, p = item.prompt ?? { question: "", options: [] }, replying = this.replying === a.address;
    const free = this.prompts.get(a.address)?.free;
    const choice = (o) => h_flex().id(`answer-${a.address}-${o.n}`).h(24).px(6).gap(7).items_center().rounded(5)
      .cursor_pointer()
      .when(p.cursor === o.n, (el) => el.bg(t.selected)).hover((st) => st.bg(t.hover))
      .tooltip(o.detail ? `${o.label} · ${o.detail}` : o.label)
      .accessibility_label(`${o.n}. ${o.label}${"checked" in o ? (o.checked ? ", checked" : ", not checked") : ""}`)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.answer(a, o, cx, p);
      })
      .child(keycap(t, String(o.n)))
      .when("checked" in o, (el) => el.child(checkbox(t, o.checked)))
      .child(div().flex_none().max_w(200).truncate().text_size(13).text_color(t.foreground)
        .child(o.n === free && /^type something/i.test(o.label) ? "Type something…" : o.label))
      .when(Boolean(o.detail), (el) => el.child(
        div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(o.detail)));
    // The question shows whole below, so the row names only what kind of ask it is.
    const short = shared(REASONS)?.[a.address] ?? reasonOf(p, terminals().find((k) => k.address === a.address)?.report);
    const kindOfAsk = p.question && short && p.question.startsWith(short.replace(/…$/, "")) ? (p.options.length ? "asks you to choose" : "waits for your reply") : short;
    return this.item(t, `in-${a.address}`, {
      turn: "me", kind: "agent", title: item.repo, reason: kindOfAsk, tip: a.tab_name || item.branch || null, open: true, machine: item.machine,
      age: ago(item.at, true), status: this.sending(a.address) ? "Answering…" : Date.now() - (this.nextAt.get(a.address) ?? 0) < NEXT_FOR ? "Next question" : null,
      ...this.localActions(item),
      lines: [
        p.ask ? this.askBlock(t, p.ask, a.address) : null,
        v_flex().children((p.question || "Waiting for you").split("\n").map((l) => div().min_w(0).text_size(13).text_color(t.foreground).child(l))),
        p.summary?.length ? v_flex().gap(3).py(4).px(8).rounded(6).bg(t.raised)
          .children(p.summary.map((s) => v_flex()
            .child(div().truncate().text_size(11).text_color(t.muted).child(s.question))
            .child(div().truncate().text_size(13).text_color(t.foreground).child(`→ ${s.answer || "(no answer)"}`)))) : null,
        p.options.length ? v_flex().gap(1).children(p.options.map(choice)) : null,
        p.preview ? div().px(8).py(5).rounded(6).border_1().border_color(t.border)
          .font_family(settings().font_family ?? "JetBrains Mono").text_size(11).text_color(t.muted)
          .children(p.preview.split("\n").slice(0, 8).map((l) => div().truncate().child(l || " "))) : null,
        this.notes.has(a.address) ? h_flex().gap(6).items_center().text_size(11).text_color(t.muted)
          .child(div().flex_1().min_w(0).truncate().child(`Note: ${this.notes.get(a.address)}`))
          .child(button(t, `note-clear-${a.address}`, [icon("x")], (cx) => {
            this.notes.delete(a.address);
            cx.notify();
          }, { size: "sm", tip: "Drop the note" })) : null,
        // A click in the field must not reach the row, which would toggle it and take the focus.
        replying ? div().id(`reply-field-${a.address}`).mt(2).h(28).px(8).flex().items_center().rounded(6).border_1()
          .border_color(t.accent).bg(t.background).on_click((_e, cx) => cx.stop_propagation()).child(Input.new(this.reply).h_full()) : null,
      ],
    });
  }

  answer(a, option, cx, seen) {
    if (option.n === this.prompts.get(a.address)?.free) return this.startReply(a, option.n, cx, "reply", seen);
    this.sendOnce(a.address, seen, cx, async ({ prompt: p, free }) => {
      if (!p.multi) return this.press(a, [...moveKeys(p, option.n), "enter"], option.label, cx);
      const leave = p.cursor != null && p.cursor === free ? ["up"] : [];
      return this.press(a, [...leave, String(option.n)], option.label, cx);
    }, seen?.multi);
  }

  submit(a, seen, cx) {
    this.sendOnce(a.address, seen, cx, async ({ prompt, free }) => {
      const leave = prompt.cursor != null && prompt.cursor === free ? ["up"] : [];
      const from = leave.length ? { ...prompt, cursor: prompt.cursor - 1 } : prompt;
      return this.press(a, [...leave, ...submitKeys(from)], "Submitted", cx);
    });
  }

  sending(address) {
    const held = this.answering.get(address);
    return held && Date.now() - held.at <= SEND_STALE ? held : null;
  }

  sendOnce(address, seen, cx, send, queue = false) {
    const busy = this.sending(address)?.turn;
    if (busy && !queue) return;
    let done;
    const turn = new Promise((resolve) => { done = resolve; });
    const mine = { turn, at: Date.now() };
    this.answering.set(address, mine);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await busy;
        if (await this.stillAsking(address, seen, cx)) await send(this.prompts.get(address), cx);
      } finally {
        if (this.answering.get(address) === mine) this.answering.delete(address);
        done();
        cx.notify();
      }
    });
  }

  async stillAsking(address, seen, cx) {
    if (!await this.rereadPrompt(address)) {
      notify({ title: "Could not read the agent's screen", body: "Nothing was sent.", level: "warning" });
      return false;
    }
    const now = this.prompts.get(address).prompt;
    const live = agents().find((a) => a.address === address)?.status === "blocked";
    if (live && (seen ? samePrompt(seen, now) : !now.options.length && !now.unparsed)) return true;
    notify({ title: "The question changed", body: "Nothing was sent. Read the card and answer again.", level: "warning" });
    cx.notify();
    return false;
  }

  async settle(address, before, cx) {
    for (let i = 0; i < SETTLE_TRIES; i++) {
      await cx.sleep(250);
      await this.rereadPrompt(address);
      const now = this.prompts.get(address)?.prompt;
      if (!before?.options.length || before.multi || !now || !samePrompt(before, now)) return;
    }
  }

  async press(a, keys, label, cx) {
    const before = this.prompts.get(a.address)?.prompt;
    const r = await hc(["keys", a.address, ...keys]);
    if (r.code !== 0) {
      notify({ title: "Could not answer", body: r.stderr.trim().split("\n")[0], level: "warning" });
      return;
    }
    await this.settle(a.address, before, cx);
    const after = this.prompts.get(a.address)?.prompt;
    if (after?.options.length && before && !samePrompt(before, after)) this.nextAt.set(a.address, Date.now());
    cx.notify();
    await this.sendNote(a);
    if (!this.prompts.get(a.address)?.prompt.multi) {
      notify({ title: `Answered ${a.tab_name || a.address}`, body: label, level: "success", timeout: 2000 });
    }
    this.scanLocal(cx);
  }

  async sendNote(a) {
    const note = this.notes.get(a.address);
    const now = this.prompts.get(a.address)?.prompt;
    if (!note || now?.options.length || now?.unparsed) return;
    this.notes.delete(a.address);
    const r = await hc(["send", a.address, `Note on my last answer: ${note}`]);
    if (r.code !== 0) notify({ title: "Could not send the note", body: r.stderr.trim().split("\n")[0], level: "warning" });
  }

  async promptOf(address, screen) {
    const prompt = readPrompt(screen);
    if (!prompt.ask?.cut || !/^[A-Za-z0-9_-]+$/.test(address)) return prompt;
    const [state, notes] = await Promise.all([hc(["get", address, "--json"]),
      exec("sh", ["-c", 'cat "$1"/*.json 2>/dev/null', "sh", `${home()}/${ASKS_DIR}/${address}`])]);
    let since = null;
    try { since = JSON.parse(state.stdout).status_ms / 1000; } catch { /* unknown: nothing is filled */ }
    return readPrompt(screen, parseNotes(notes.stdout, address), since);
  }

  async rereadPrompt(address) {
    const r = await hc(["read", address, "--lines", "0"]);
    if (r.code !== 0 || !r.stdout.trim()) return false;
    const was = this.prompts.get(address);
    const prompt = await this.promptOf(address, r.stdout);
    this.prompts.set(address, { since: was?.since, prompt, free: freeOption(prompt, was?.free) });
    for (const i of this.local) if (i.agent.address === address) i.prompt = this.prompts.get(address).prompt;
    return true;
  }

  startReply(a, key, cx, mode = "reply", seen = null) {
    this.replying = a.address;
    this.replyKey = key;
    this.replyMode = mode;
    this.replySeen = seen;
    this.reply.set_value("");
    this.reply.focus();
    cx.notify();
  }

  sendReply(cx) {
    const text = this.reply.value().trim(), address = this.replying, key = this.replyKey, mode = this.replyMode;
    const seen = this.replySeen;
    if (mode !== "note" && text && this.sending(address)) {
      notify({ title: "Still answering this agent", body: "Nothing was sent. Try again in a moment.", level: "warning" });
      return;
    }
    this.replying = null;
    this.replyKey = null;
    this.replyMode = null;
    if (mode === "note" && address) {
      if (text) this.notes.set(address, text);
      return cx.notify();
    }
    cx.notify();
    if (!text || !address) return;
    this.sendOnce(address, seen, cx, async ({ prompt: p }, cx) => {
      const failed = (r) => {
        if (!r || r.code === 0) return false;
        notify({ title: "Could not reply", body: r.stderr.trim().split("\n")[0], level: "warning" });
        return true;
      };
      const keys = (list) => (list.length ? hc(["keys", address, ...list]) : null);
      const moved = key && p?.multi ? await keys(moveKeys(p, key)) : key && p?.cursor !== key ? await keys([String(key)]) : null;
      if (failed(moved)) return;
      if (failed(await hc(["send", "--force", address, text]))) return;
      if (key && p?.multi) {
        await cx.sleep(250);
        await this.rereadPrompt(address);
        const now = this.prompts.get(address)?.prompt;
        if (now && sameChoicesBut(key, p, now)) await keys(now.options.find((o) => o.n === key)?.checked ? ["up"] : ["up", String(key)]);
      }
      await this.settle(address, p, cx);
      cx.notify();
      this.scanLocal(cx);
    });
  }
}
