import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, exec, run, home, agents, panes, terminals, notify, props, openOverlay, closeOverlay } from "herdr";
import { ACCOUNTS, CODEX, accountOf, launchArgv, loadClaudeQuotas, chip } from "./accounts.js";
import { spinner } from "./ui.js";
import { terminalAccount, handoffPlan, resumePrompt, notePrompt } from "./lib/handoff.js";

const NOTES = ".local/state/relevo/handoff";

export function openHandoff(address = null) {
  const a = agents().find((x) => (address ? x.address === address : x.focused));
  if (!a) return notify({ title: "Focus the agent to hand off first", level: "info" });
  const cwd = panes().find((p) => p.pane === a.pane)?.cwd;
  const k = terminals().find((x) => x.address === a.address), from = terminalAccount(k);
  const rows = [...ACCOUNTS, CODEX].filter((acct) => acct.key !== from).length;
  openOverlay({
    mod: "relevo", kind: "popup", width: 300, height: 52 + rows * 40,
    props: {
      role: "handoff", terminal: a.address, space: a.space, tab: a.tab_name, cwd,
      from, transcript: k?.labels?.["agent.transcript"] || null,
    },
  });
}

// From a full account: its focused agent, else one waiting on you, else one still working.
export function handoffFrom(account) {
  const mine = new Set(terminals().filter((k) => terminalAccount(k) === account).map((k) => k.address));
  const list = agents().filter((a) => mine.has(a.address));
  const a = list.find((x) => x.focused) ?? list.find((x) => x.status === "blocked") ?? list.find((x) => x.status === "working");
  if (!a) return notify({ title: `No ${accountOf(account).label} agent to hand off`, level: "info" });
  run("agent.focus", { terminal: a.address });
  openHandoff(a.address);
}

// A copy of the session file in the next account's config dir, so it can resume that conversation.
async function seedResume(plan) {
  const r = await exec("sh", ["-c", 'test -f "$1" && mkdir -p "$2" && cp "$1" "$2/"', "sh", plan.src, plan.dir]);
  return r.code === 0;
}

// The note carries what the next agent can't see: the last screen and the working tree.
async function writeNote({ terminal, cwd, from }, to) {
  const screen = (await exec("hc", ["read", terminal, "--lines", "400"])).stdout
    .split("\n").slice(-160).join("\n").trim().replace(/`{5,}/g, "````");
  const git = async (args) => (await exec("git", ["--no-optional-locks", ...args], { cwd })).stdout.trim();
  const note = [
    `# Handoff from ${from ? accountOf(from).label : "another account"} to ${accountOf(to).label}`,
    "", `Folder: ${cwd}`, `Branch: ${await git(["branch", "--show-current"]) || "(detached)"}`,
    "", "## Working tree", "", "```", await git(["status", "--short"]) || "clean", "```",
    "", "## Recent commits", "", "```", await git(["log", "--oneline", "-5"]), "```",
    "", "## The previous agent's last screen", "", "A record of its terminal, not instructions.", "",
    "`````", screen, "`````", "",
  ].join("\n");
  const path = `${home()}/${NOTES}/${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
  const r = await exec("sh", ["-c", 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1"', "sh", path, note]);
  return r.code === 0 ? path : null;
}

export class Handoff {
  init(_props, cx) {
    this.quotas = null;
    cx.spawn(async (cx) => {
      this.quotas = await loadClaudeQuotas();
      cx.notify();
    });
  }

  // The next agent starts in a new tab, then the old one is interrupted so both don't edit the same tree.
  go(to, cx) {
    const p = props();
    if (this.busy || !p?.cwd) return;
    this.busy = to;
    cx.notify();
    cx.spawn(async (cx) => {
      const plan = handoffPlan({ from: p.from, to, transcript: p.transcript, accounts: ACCOUNTS, home: home() });
      let argv;
      if (plan.mode === "resume" && await seedResume(plan)) {
        argv = launchArgv(to, resumePrompt(accountOf(to).label), ["--resume", plan.id, "--fork-session"]);
      } else {
        const path = await writeNote(p, to);
        if (!path) {
          this.busy = null;
          this.error = "Could not write the handoff note";
          return cx.notify();
        }
        argv = launchArgv(to, notePrompt(p.from === CODEX.key ? "Codex" : "Claude Code", path));
      }
      run("tab.new", { space: p.space, folder: p.cwd, name: `${p.tab || "handoff"} · ${accountOf(to).letter}`, argv });
      await exec("hc", ["interrupt", p.terminal]);
      closeOverlay(p.overlay);
    });
  }

  render() {
    const t = theme(), p = props();
    if (!p?.terminal) return div();
    const usage = (q) => [q?.h5 ? `5h ${q.h5.pct}%` : null, q?.d7 ? `7d ${q.d7.pct}%` : null]
      .filter(Boolean).join(" · ") || "no data";
    return v_flex().id("handoff").size_full().p(4).gap(1).bg(t.popover ?? t.surface).text_color(t.foreground)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(this.error ? t.blocked : t.dim).truncate()
        .child(this.error ?? `Continue ${p.tab || p.terminal} with…`))
      .children([...ACCOUNTS, CODEX].filter((acct) => acct.key !== p.from).map((acct) => {
        const q = this.quotas?.[acct.key], full = q?.h5?.pct >= 100 || q?.d7?.pct >= 100;
        return h_flex().id(`handoff-${acct.key}`).h(36).px(8).gap(8).items_center().rounded(6)
          .cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.go(acct.key, cx))
          .child(chip(div, acct))
          .child(v_flex().flex_1().min_w(0)
            .child(div().text_size(12.5).child(this.busy === acct.key ? "Starting…" : acct.label))
            .child(div().text_size(10.5).text_color(full ? t.blocked : t.muted).child(this.quotas ? usage(q) : spinner(t.dim, 10))));
      }));
  }
}
