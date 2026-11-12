// The Inbox's pull requests: fetch, cards, skill buttons. Mixed into Inbox, so `this` is the Inbox.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Button } from "gpui-base";
import { home, exec, run, notify, shared, setShared, openOverlay, readTextFile } from "herdr";
import { accountOf, pickAccount, chip } from "./accounts.js";
import { contextFor } from "./context.js";
import { reviewAlerts, prAlerts, mergedAlert } from "./alerts.js";
import { REPOS_ROOT } from "./config.js";
import { LAUNCHED, SKILLS, configuredSkill, launched, launchSkill } from "./skills.js";
import { button, sectionHeader, spinner, withKey, foldRow } from "./ui.js";
import { openReview } from "./review.js";
import { checkoutOf, scanWorktrees } from "./worktrees.js";
import { ago } from "./lib/time.js";
import { MINE_PAGES, OTHERS_QUERY, joinPRs, mineQuery, cancelledRuns, ciOf, seconds, recent, mapDrafts, mapMine, mapReady, mapRequested, openPRs, prChanges } from "./lib/github.js";
import { mergeFlag, prMoves } from "./lib/land.js";
import { keepListed } from "./lib/addressed.js";
import { localBranch, pullRef, pullRefspec } from "./lib/prmenu.js";
import { DESKTOP } from "./desktop.js";
import { desktopKey } from "./lib/desktop.js";

const ADDRESSED = ".local/state/relevo/addressed.json";

const contextKey = (repo) => contextFor(repo).key;
const STUCK_MS = 120000;

export class PrViews {
  // Launched skills, read once per render.
  launchedMap() {
    return this.snap?.launched ?? launched();
  }

  loadAddressed(cx) {
    cx.spawn(async (cx) => {
      try {
        this.addressed = JSON.parse(await readTextFile(`${home()}/${ADDRESSED}`) ?? "{}") ?? {};
      } catch {
        this.addressed = {};
      }
      this.publish();
      cx.notify();
    });
  }

  // Marks or unmarks a PR as addressed and writes the marks file.
  setAddressed(pr, on, cx) {
    const next = { ...this.addressed };
    if (on) next[pr.url] = Math.ceil(Date.now() / 1000);
    else delete next[pr.url];
    this.saveAddressed(next);
    this.publish();
    cx.notify();
  }

  saveAddressed(marks) {
    this.addressed = marks;
    exec("sh", ["-c", 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1"', "sh", `${home()}/${ADDRESSED}`, JSON.stringify(marks)]);
  }

  // A scan stuck past STUCK_MS (an exec that never answered) no longer blocks the next one.
  scanPRs(cx) {
    if (this.scanningPRs && Date.now() - this.scanStarted < STUCK_MS) return;
    this.scanningPRs = true;
    this.scanStarted = Date.now();
    if (!this.prsAt) cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.loadPRs();
      } catch (e) {
        this.error = `PRs: ${e?.message ?? e}`;
      } finally {
        this.scanningPRs = false;
        cx.notify();
      }
    });
  }

  // One GraphQL query, tried twice: GitHub's 502s and cut answers come and go.
  async graphql(query) {
    let last = "gh failed";
    for (let i = 0; i < 2; i++) {
      const r = await exec("gh", ["api", "graphql", "-f", `query=${query}`]);
      if (r.code === 0) {
        try {
          return { data: JSON.parse(r.stdout).data };
        } catch {
          last = "GitHub's answer was cut short";
          continue;
        }
      }
      last = (r.stderr?.trim() || last).split("\n")[0];
    }
    return { error: last };
  }

  async loadPRs() {
    const [first, others] = await Promise.all([this.graphql(mineQuery()), this.graphql(OTHERS_QUERY)]);
    const pages = [first];
    while (pages.length < MINE_PAGES && pages.at(-1).data?.viewer?.pullRequests?.pageInfo?.hasNextPage) {
      pages.push(await this.graphql(mineQuery(pages.at(-1).data.viewer.pullRequests.pageInfo.endCursor)));
    }
    const failed = [...pages, others].find((r) => r.error);
    if (failed) {
      this.error = failed.error;
      return;
    }
    this.error = null;
    const data = joinPRs(pages.map((r) => r.data), others.data);
    this.mine = mapMine(data);
    this.requested = mapRequested(data);
    const listed = new Set(this.mine.map((p) => p.url));
    this.ready = mapReady(data).filter((p) => !listed.has(p.url));
    this.drafts = mapDrafts(data);
    this.openPRs = openPRs(data);
    this.prsAt = Date.now() / 1000;
    const changes = prChanges(this.prState, data);
    this.prState = changes.state;
    this.away?.events.push(...changes.events);
    prAlerts(changes.events.filter((e) => e.kind !== "merged"), contextKey);
    for (const e of changes.events.filter((x) => x.kind === "merged")) await this.merged(e);
    for (const p of [...this.mine, ...this.ready, ...this.requested]) {
      if (p.repo in this.clones) continue;
      const path = `${home()}/${REPOS_ROOT}/${p.repo.split("/")[1]}`;
      // Same folder name can belong to another owner's repo.
      const origin = await exec("git", ["-C", path, "remote", "get-url", "origin"]);
      const same = origin.code === 0 && origin.stdout.trim().replace(/\.git$/, "").toLowerCase()
        .endsWith(`github.com${origin.stdout.includes("@github.com:") ? ":" : "/"}${p.repo.toLowerCase()}`);
      this.clones[p.repo] = same ? path : null;
    }
    const live = new Set([...this.mine, ...this.ready, ...this.requested].map((p) => p.url));
    for (const s of shared(DESKTOP) ?? []) live.add(desktopKey(s));
    const marks = keepListed(this.addressed, live);
    if (Object.keys(marks).length !== Object.keys(this.addressed).length) this.saveAddressed(marks);
    const kept = Object.entries(this.launchedMap()).filter(([url]) => live.has(url));
    if (kept.length !== Object.keys(this.launchedMap()).length) setShared(LAUNCHED, Object.fromEntries(kept));
    reviewAlerts(this.requested, contextKey);
    this.publish();
  }

  // A merged PR's worktree shows at once, selected for the shortcut that opens the Inbox, so Remove is one look away.
  async merged(e) {
    const clone = this.clones[e.repo], name = e.repo.split("/")[1];
    let tree = null;
    if (e.head) {
      this.treesAt = Date.now();
      this.worktrees = await scanWorktrees(true).catch(() => this.worktrees);
      tree = this.worktrees.find((w) => w.merged && w.branch === e.head && (clone ? w.main === clone : w.repo === name)) ?? null;
    }
    if (tree) this.pendingSel = { id: `wt-${tree.path}`, at: Date.now() };
    mergedAlert(e, tree, contextKey);
  }

  openSkillMenu(pr, skill = pr.skills?.[0] ?? "review") {
    if (!this.clones[pr.repo]) return;
    const current = pickAccount(pr.repo, this.quotas).key;
    openOverlay({ mod: "relevo", kind: "popup", width: 360, height: 170 + 34 * Object.keys(SKILLS).length,
      props: { role: "account-menu", pr: { url: pr.url, number: pr.number, repo: pr.repo, updatedAt: pr.updatedAt, title: pr.title,
        headRefName: pr.headRefName, baseRefName: pr.baseRefName, isCrossRepository: pr.isCrossRepository, untrusted: Boolean(pr.untrusted) },
      skill, folder: this.clones[pr.repo], current } });
  }

  // The left part runs the skill with the picked account; ▾ picks the account, other skills or a new session.
  skillButton(t, pr, skill, solid) {
    const folder = this.clones[pr.repo], action = configuredSkill(skill), available = Boolean(action);
    const pick = pickAccount(pr.repo, this.quotas), acct = accountOf(pick.key);
    const tip = available ? pick.note ?? `Runs with ${acct.label}, the account for ${pr.repo.split("/")[0]}` : "This action is no longer configured. Choose another action from the picker.";
    const fg = solid ? t.solid_foreground : t.foreground;
    return h_flex().id(`skill-${skill}-${pr.url}`).h(24).flex_none().rounded(6).overflow_hidden()
      .when(solid, (el) => el.bg(t.solid))
      .when(!solid, (el) => el.border_1().border_color(t.border))
      .child(Button.new(`run-${skill}-${pr.url}`).id(`run-${skill}-${pr.url}`).tab_index(0)
        .disabled(!available).tab_stop(available)
        .accessibility_label(available ? `Run ${action.name} with ${acct.label}. ${tip}` : `Skill unavailable. ${tip}`).focus((s) => s.border_2().border_color(t.accent))
        .flex().h_full().pl(9).pr(7).gap(5).items_center().cursor_pointer()
        .text_size(11).text_color(available ? fg : t.dim)
        .tooltip(tip).hover((s) => s.bg(solid ? t.solid : t.hover))
        .when(available, (el) => el.on_click((_e, cx) => {
          cx.stop_propagation();
          launchSkill(pr, skill, pick.key, folder);
          this.publish();
          cx.notify();
        }))
        .child(action?.name ?? "Skill unavailable")
        .child(chip(div, acct, 15)))
      .child(Button.new(`pick-${skill}-${pr.url}`).id(`pick-${skill}-${pr.url}`).tab_index(0)
        .accessibility_label("Choose skill and account").focus((s) => s.border_2().border_color(t.accent))
        .h_full().px(6).flex().items_center().cursor_pointer()
        .text_size(11).text_color(fg)
        .border_l(1).border_color(solid ? t.solid_foreground : t.border)
        .hover((s) => s.bg(solid ? t.solid : t.hover)).tooltip("Choose the account")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.openSkillMenu(pr, skill);
        })
        .child("▾"));
  }

  threadBadge(t, n, key) {
    return h_flex().id(`threads-${key}`).flex_none().gap(3).items_center().text_size(11).text_color(t.ansi3)
      .tooltip(`${n} unresolved ${n === 1 ? "thread" : "threads"}`)
      .child(svg("mods/relevo/thread.svg").size(11).text_color(t.ansi3))
      .child(String(n));
  }

  ciBadge(t, state, key) {
    const [glyph, color, tip] = state === "SUCCESS" ? ["✓", t.ansi2, "CI passed"]
      : state === "FAILURE" || state === "ERROR" ? ["✕", t.ansi1, "CI failed"]
        : state === "CANCELLED" ? ["⊘", t.ansi3, "CI cancelled"] : ["◌", t.ansi3, "CI running"];
    return div().id(`ci-${key}`).flex_none().text_size(11).font_semibold().text_color(color).tooltip(tip)
      .child(glyph === "◌" ? spinner(color, 11) : glyph);
  }

  // Only the failed and cancelled jobs of each run go again; a run with none left says so.
  retryCI(pr, cx) {
    this.retrying ??= new Set();
    if (this.retrying.has(pr.url)) return;
    this.retrying.add(pr.url);
    cx.notify();
    cx.spawn(async (cx) => {
      const name = `${pr.repo.split("/")[1]} #${pr.number}`;
      try {
        // gh exits non-zero when checks failed, so only the answer tells.
        const checks = await exec("gh", ["pr", "checks", String(pr.number), "--repo", pr.repo, "--json", "state,link"]);
        let runs;
        try {
          runs = cancelledRuns(JSON.parse(checks.stdout));
        } catch {
          return notify({ title: `Could not read CI · ${name}`, body: checks.stderr?.trim().split("\n")[0], level: "warning" });
        }
        if (!runs.length) return notify({ title: `Nothing to retry · ${name}`, body: "No failed or cancelled GitHub Actions run", level: "warning" });
        for (const id of runs) {
          const r = await exec("gh", ["run", "rerun", id, "--failed", "--repo", pr.repo]);
          if (r.code !== 0) return notify({ title: `Could not retry CI · ${name}`, body: r.stderr?.trim().split("\n")[0], level: "warning" });
        }
        notify({ title: `CI restarted · ${name}`, level: "success" });
        this.scanPRs(cx);
      } finally {
        this.retrying.delete(pr.url);
        cx.notify();
      }
    });
  }

  // One gh pr command on a PR, then a fresh look.
  prCommand(pr, args, done, cx) {
    cx.spawn(async (cx) => {
      const name = `${pr.repo.split("/")[1]} #${pr.number}`;
      const r = await exec("gh", ["pr", ...args, String(pr.number), "--repo", pr.repo]);
      if (r.code !== 0) return notify({ title: `Could not do it · ${name}`, body: r.stderr?.trim().split("\n")[0], level: "warning" });
      notify({ title: `${done} · ${name}`, level: "success" });
      this.scanPRs(cx);
    });
  }

  draftCard(t, pr) {
    return this.card(t, `pr-${pr.url}`, false,
      this.head(t, "ring", `${pr.repo.split("/")[1]} #${pr.number} · ${pr.title}`, ago(seconds(pr.updatedAt)), ciOf(pr), pr.threads),
      v_flex().text_size(11).text_color(t.muted).child("draft"),
      [
        button(t, `ready-${pr.url}`, "Ready for review", (cx) => this.prCommand(pr, ["ready"], "Ready for review", cx)),
        button(t, `open-${pr.url}`, "Open PR", () => exec("open", [pr.url])),
        this.sourceContextButton(t, `pr:${pr.url}`),
        button(t, `source-skills-pr:${pr.url}`, "Skills…", () => this.openSkillMenu(pr), { size: "sm", disabled: !this.clones[pr.repo], tip: "Choose a skill and account before running" }),
      ]);
  }

  // What the PR's agent left running when its turn ended, like a monitor waiting on CI: null when nothing.
  backgroundOf(agent) {
    const labels = agent ? this.terms?.get(agent.address)?.labels : null;
    return labels?.["agent.wait"] === "watch" ? labels["agent.bg"] ?? "" : null;
  }

  // Its agent is still on it: working, asking, or waiting on something it started.
  prBusy(pr) {
    const agent = this.prAgents[pr.url];
    return Boolean(agent) && (agent.status === "working" || agent.status === "blocked" || this.backgroundOf(agent) !== null);
  }

  agentLine(pr, agent) {
    const l = this.launchedMap()[pr.url], name = configuredSkill(l.skill)?.name ?? "Previous skill", bg = this.backgroundOf(agent);
    if (!agent) return `${name} ran ${ago(l.at)}`;
    if (agent.status === "working") return `${name} working…`;
    if (bg !== null && agent.status !== "blocked") return `${name} waiting in the background${bg ? ` · ${bg}` : ""}`;
    if (agent.status === "blocked") return `${name} is waiting for you`;
    return l.skill === "review" ? "draft review ready on GitHub" : `${name} finished`;
  }

  prCard(t, pr, requested, addressed = false) {
    const l = this.launchedMap()[pr.url], agent = this.prAgents[pr.url], seen = this.seen(pr), busy = Boolean(l) && this.prBusy(pr);
    const meta = requested ? `review requested · ${pr.author?.login ?? ""}` : pr.reasons.join(" · ");
    const done = Boolean(l && seen) && (!agent || agent.status === "idle" || agent.status === "done");
    const openPR = button(t, `open-${pr.url}`, "Open PR", () => exec("open", [pr.url]), {
      kind: done && l.skill === "review" ? "solid" : "outline",
    });
    const actions = done && l.skill === "review" ? [openPR] : [];
    if (agent) actions.push(button(t, `agent-${pr.url}`, "Agent", () => run("agent.focus", { terminal: agent.address })));
    if (this.clones[pr.repo] && !(seen && agent) && !busy) {
      pr.skills.forEach((s) => actions.push(this.skillButton(t, pr, s, !seen && !requested && (s === "conflicts" || (pr.hot && s === "fix")))));
    }
    if (!requested && this.clones[pr.repo]) {
      actions.push(button(t, `review-pr-${pr.url}`, "Review", () => this.reviewPR(pr), {
        tip: withKey("The whole PR against its base, line by line", "relevo.review"),
      }));
    }
    const moves = requested ? {} : prMoves(pr), landing = Boolean(this.landing()[pr.url]);
    if ((moves.land || moves.auto) && !landing) {
      const key = `land-${pr.url}`, armed = this.armed(key), how = mergeFlag(pr.repository).slice(2);
      const label = moves.land ? "Land" : "Land when ready";
      actions.unshift(button(t, `land-btn-${pr.url}`, armed ? `Confirm ${label.toLowerCase()}` : label,
        (cx) => this.arm(key, cx, () => this.land(pr, !moves.land, cx)), {
          kind: armed ? "danger" : "solid",
          tip: moves.land
            ? `Merges (${how}), follows the workflows it starts, then removes its worktree if nothing would be lost`
            : `Turns on auto-merge (${how}) and follows it like Land`,
        }));
    }
    if (moves.update) {
      actions.push(button(t, `update-${pr.url}`, "Update branch", (cx) => this.prCommand(pr, ["update-branch"], "Branch updated", cx), {
        tip: `Merges ${pr.baseRefName} into it on GitHub`,
      }));
    }
    if (moves.rerun) {
      actions.push(button(t, `retry-ci-${pr.url}`, "Retry CI", (cx) => this.retryCI(pr, cx), {
        tip: "Runs the failed and cancelled jobs again", disabled: this.retrying?.has(pr.url),
      }));
    }
    if (!actions.includes(openPR)) actions.push(openPR);
    const context = this.sourceContextButton(t, `pr:${pr.url}`);
    if (context) actions.push(context);
    const mark = addressed
      ? button(t, `undo-${pr.url}`, "Undo", (cx) => this.setAddressed(pr, false, cx), { tip: "Back to the list" })
      : button(t, `addressed-${pr.url}`, "✓", (cx) => this.setAddressed(pr, true, cx), {
        tip: "Addressed: hide until there's new activity",
      });
    const dot = seen ? "ring" : !requested && pr.hot ? t.blocked : t.accent;
    return this.card(t, `pr-${pr.url}`, false,
      this.head(t, dot, `${pr.repo.split("/")[1]} #${pr.number} · ${pr.title}`, ago(seconds(pr.updatedAt)),
        ciOf(pr), pr.threads),
      v_flex().gap(2).text_size(11).text_color(t.muted)
        .when(Boolean(meta), (el) => el.child(meta))
        .when(Boolean(l && (seen || busy)), (el) => el.child(
          div().text_color(agent?.status === "working" || this.backgroundOf(agent) !== null ? t.working : t.dim).child(this.agentLine(pr, agent)))),
      this.foldActions(t, `pr-${pr.url}`, actions, mark));
  }

  // The review pane on the PR's checkout, else on its exact head; comments go to its agent, or a new one when none runs.
  async reviewPR(pr) {
    const clone = this.clones[pr.repo];
    const info = { repo: pr.repo, number: pr.number, url: pr.url, base: pr.baseRefName, head: pr.headRefName };
    const folder = await checkoutOf(clone, localBranch(pr));
    if (!folder) {
      const r = await exec("git", ["-C", clone, "fetch", "--quiet", "origin", pullRefspec(pr)]);
      if (r.code !== 0) {
        return notify({ title: `Could not fetch PR #${pr.number}`, body: r.stderr.trim().split("\n")[0], level: "warning" });
      }
      info.ref = pullRef(pr);
    }
    openReview(folder ?? clone, this.prAgents[pr.url]?.address ?? null, info);
  }

  // Old PRs fold under one line so each group shows what needs you this month, addressed ones under another,
  // and yours that only wait for the merge under a third, out of the count.
  prGroup(t, key, label, list, requested, done = [], ready = []) {
    if (!list.length && !done.length && !ready.length && (requested || !this.drafts?.length)) return [];
    const fresh = list.filter(recent), old = list.filter((p) => !recent(p)), open = this.expanded[key];
    const rows = [sectionHeader(t, label, fresh.length), ...fresh.map((p) => this.prCard(t, p, requested))];
    if (old.length) {
      rows.push(foldRow(this, t, `older-${key}`, key, `${old.length} older than 45 days`));
      if (open) rows.push(...old.map((p) => this.prCard(t, p, requested)));
    }
    if (ready.length) {
      rows.push(foldRow(this, t, `ready-${key}`, `${key}-ready`, `${ready.length} ready to merge`));
      if (this.expanded[`${key}-ready`]) rows.push(...ready.map((p) => this.prCard(t, p, requested)));
    }
    const drafts = requested ? [] : this.drafts ?? [];
    if (drafts.length) {
      rows.push(foldRow(this, t, `drafts-${key}`, `${key}-drafts`, `${drafts.length} ${drafts.length === 1 ? "draft" : "drafts"}`));
      if (this.expanded[`${key}-drafts`]) rows.push(...drafts.map((p) => this.draftCard(t, p)));
    }
    rows.push(...this.addressedFold(t, key, done, (p) => this.prCard(t, p, requested, true)));
    return rows;
  }
}
