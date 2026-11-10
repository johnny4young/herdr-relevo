import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, exec, home, props, terminals, openOverlay, closeOverlay } from "herdr";
import { ACCOUNTS, accountOf, chip, openInFolder, resumeArgv } from "./accounts.js";
import { contextOfPath, inFocus } from "./context.js";
import { focusedCwd } from "./panelbar.js";
import { spinner } from "./ui.js";
import { ago } from "./lib/time.js";
import { parseIndex, parseDetails, titleOf, inRepo, matches } from "./lib/sessions.js";

const SHOWN = 60, CHECKED = 150;
const keyOf = (s) => `${s.account}/${s.id}`;

// The last line per session in each account's history: "account\tms\tproject\tid".
const INDEX = 'for s; do k=${s%%|*}; f=${s#*|}; [ -f "$f" ] || continue; '
  + 'LC_ALL=C grep -oE \'"timestamp":[0-9]+,"project":"[^"]*","sessionId":"[^"]+"\' "$f" '
  + '| awk -F\'"\' -v k="$k" \'{ t=$3; gsub(/[^0-9]/, "", t); last[$10] = k "\\t" t "\\t" $6 "\\t" $10 } END { for (i in last) print last[i] }\'; done';

// Titles, branch and PR from the end of each session file, where Claude keeps rewriting them. BSD grep
// takes at most 255 repeats, so a long prompt arrives cut and without its closing quote.
const DETAILS = 'for s; do k=${s%%|*}; id=${s##*|}; d=${s#*|}; d=${d%|*}; key="$k/$id"; for f in "$d"/projects/*/"$id".jsonl; do [ -f "$f" ] || continue; '
  + 'printf \'%s\\t"file":true\\n\' "$key"; tail -c 262144 "$f" | LC_ALL=C grep -oE \'"(customTitle|lastPrompt|gitBranch)":"([^"\\\\]|\\\\.){0,200}"?|"prNumber":[0-9]+\' '
  + '| awk -v id="$key" \'{ print id "\\t" $0 }\'; done; done';

const MISSING = 'for p; do [ -d "$p" ] || printf "%s\\n" "$p"; done';

export async function openSessions() {
  const cwd = focusedCwd();
  let top = null;
  if (cwd) {
    const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
    if (r.code === 0) top = r.stdout.trim().replace(/\/\.git\/?$/, "");
  }
  openOverlay({ mod: "relevo", kind: "dialog", width: 760, height: 0.6, props: { role: "sessions", top } });
}

// Type to filter, ↑/↓ and Enter to resume, Tab for this repo or all, Esc to close.
export class SessionFinder {
  init(_props, cx) {
    this.h = cx.focus_handle();
    this.query = "";
    this.at = 0;
    this.scope = props()?.top ? "repo" : "all";
    this.all = null;
    this.details = {};
    this.missing = new Set();
    this.h.focus();
    cx.timer.after(300, () => this.h.focus());
    cx.spawn(async (cx) => {
      const specs = ACCOUNTS.filter((a) => a.claudeDir).map((a) => `${a.key}|${home()}/${a.claudeDir}/history.jsonl`);
      const r = await exec("sh", ["-c", INDEX, "sh", ...specs]);
      // Keyed by config dir, so accounts sharing one hide the same copy.
      const rootOf = (a) => `${home()}/${a.claudeDir.replace(/\/+$/, "")}`;
      const roots = ACCOUNTS.filter((a) => a.claudeDir).map(rootOf);
      const running = new Set(terminals().map((k) => {
        const transcript = k.labels?.["agent.transcript"] ?? "";
        const id = /([0-9a-f-]{36})\.jsonl$/i.exec(transcript)?.[1];
        // An unrecognized path still hides that id rather than offering an active conversation.
        return id ? `${roots.find((d) => transcript.startsWith(`${d}/projects/`)) ?? "*"}/${id}` : null;
      }).filter(Boolean));
      this.all = parseIndex(r.stdout ?? "")
        .filter((s) => !running.has(`${rootOf(accountOf(s.account))}/${s.id}`) && !running.has(`*/${s.id}`));
      await this.loadDetails(cx);
    });
  }

  inScope() {
    const top = props()?.top, name = top?.split("/").pop();
    return (this.all ?? []).filter((s) => (this.scope === "repo"
      ? inRepo(s.project, top, name, home())
      : inFocus(contextOfPath(s.project))));
  }

  async loadDetails(cx) {
    const want = this.inScope().slice(0, CHECKED).filter((s) => !(keyOf(s) in this.details));
    if (want.length) {
      const dir = (s) => `${home()}/${accountOf(s.account).claudeDir}`;
      const [d, m] = await Promise.all([
        exec("sh", ["-c", DETAILS, "sh", ...want.map((s) => `${s.account}|${dir(s)}|${s.id}`)]),
        exec("sh", ["-c", MISSING, "sh", ...new Set(want.map((s) => s.project))]),
      ]);
      const found = parseDetails(d.stdout ?? "");
      // Claude deletes old transcripts; without one there is nothing to resume.
      for (const s of want) this.details[keyOf(s)] = found[keyOf(s)] ?? null;
      for (const p of (m.stdout ?? "").split("\n").filter(Boolean)) this.missing.add(p);
    }
    cx.notify();
  }

  rows() {
    return this.inScope().slice(0, CHECKED).filter((s) => this.details[keyOf(s)]).slice(0, SHOWN).map((s) => {
      const d = this.details[keyOf(s)];
      return { ...s, title: titleOf(d) || s.project.split("/").pop(), branch: d?.gitBranch, pr: d?.prNumber, gone: this.missing.has(s.project) };
    }).filter((s) => matches(s, this.query));
  }

  open(row) {
    if (!row || row.gone) return;
    closeOverlay(props().overlay);
    const name = row.project.split("/").pop();
    openInFolder({ name, folder: row.project, tab: `${row.title.slice(0, 24)} · ${accountOf(row.account).letter}`, argv: resumeArgv(row.account, row.id) });
  }

  key(e, cx) {
    const rows = this.rows(), n = rows.length, held = e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt;
    if (e.key === "escape") return closeOverlay(props().overlay);
    if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
    else if (e.key === "enter") this.open(rows[this.at]);
    else if (e.key === "tab" && props()?.top) {
      this.scope = this.scope === "repo" ? "all" : "repo";
      this.at = 0;
      cx.spawn(async (cx) => this.loadDetails(cx));
    } else if (e.key === "backspace") {
      this.query = this.query.slice(0, -1);
      this.at = 0;
    } else if (e.key_char && !held && e.key_char !== "\t") {
      this.query += e.key_char;
      this.at = 0;
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  render() {
    const t = theme(), rows = this.all ? this.rows() : [], top = props()?.top;
    const tabs = [["repo", top?.split("/").pop() ?? "This repo"], ["all", "All"]];
    return v_flex().id("sessions").size_full().p(12).gap(8).bg(t.popover ?? t.surface).text_color(t.foreground)
      .text_size(13).track_focus(this.h).on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().gap(8).items_center()
        .child(div().id("sessions-query").flex_1().h(32).px(10).flex().items_center().rounded(6).border(1)
          .border_color(t.accent).bg(t.background).text_color(this.query ? t.foreground : t.dim)
          .child(this.query || "Type to filter"))
        .when(Boolean(top), (el) => el.child(h_flex().id("sessions-scope").h(26).p(2).gap(2).rounded(6).bg(t.raised)
          .text_size(11).tooltip("Tab switches")
          .children(tabs.map(([key, label]) => div().id(`scope-${key}`).h_full().px(8).flex().items_center().rounded(4)
            .cursor_pointer().text_color(this.scope === key ? t.foreground : t.dim)
            .when(this.scope === key, (s) => s.bg(t.selected))
            .on_click((_e, cx) => {
              this.scope = key;
              this.at = 0;
              cx.spawn(async (cx) => this.loadDetails(cx));
            })
            .child(label))))))
      .child(v_flex().id("sessions-list").flex_1().min_h(0).overflow_y_scrollbar()
        .when(!this.all, (el) => el.child(h_flex().p(8).child(spinner(t.dim))))
        .when(Boolean(this.all) && !rows.length, (el) => el.child(div().p(8).text_color(t.dim).child("No sessions")))
        .children(rows.map((r, i) => h_flex().id(`session-${r.account}-${r.id}`).h(34).px(8).gap(8).flex_none()
          .items_center().rounded(6)
          .when(i === this.at, (el) => el.bg(t.selected))
          .when(!r.gone, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.open(r)))
          .when(r.gone, (el) => el.opacity(0.5).tooltip("Its folder is gone"))
          .child(chip(div, accountOf(r.account), 15))
          .child(div().flex_1().min_w(0).truncate().child(r.title))
          .child(div().flex_none().max_w(220).truncate().text_size(11).text_color(t.dim)
            .child(`${r.project.split("/").pop()}${r.branch ? ` · ${r.branch}` : ""}`))
          .when(Boolean(r.pr), (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child(`#${r.pr}`)))
          .child(div().flex_none().w(52).text_right().text_size(11).text_color(t.dim).child(ago(r.at / 1000))))));
  }
}
