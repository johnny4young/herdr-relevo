import { GOAL_MODE, GOAL_SCOPE } from "./inbox-goals.js";
import { GoalEditor, openGoal } from "./goals-editor.js";
import { View } from "gpui-kit";
import { PREVIEW_ROLES } from "./decision-preview.js";
import { SnapshotDetail, SnapshotBanner } from "./snapshot-preview.js";
import { props, nextCommand, setShared } from "herdr";
import { Sidebar } from "./sidebar.js";
import { Inbox } from "./inbox.js";
import { InboxButton, PanelToggle, showPanel } from "./toolbar.js";
import { AccountMenu } from "./account-menu.js";
import { PanelBar, FileFinder, CheckoutMenu, openFinder, openCheckoutsHere } from "./panelbar.js";
import { nextWaiting, openPR, respondPR, worktrees } from "./commands.js";
import { Handoff, openHandoff, handoffFrom, closeHandedOff } from "./handoff.js";
import { ReviewDiff, openReview } from "./review.js";
import { loadKeys } from "./ui.js";
import { LedgerWeek, openWeek } from "./week.js";
import { Settings, openSettings } from "./settings.js";
import { focusInbox } from "./inbox-keys.js";
import { QuickReplies, openReplies } from "./replies.js";
import { SessionFinder, openSessions } from "./sessions.js";
import { UsageDialog, openUsage } from "./usage.js";

const ROLES = {
  "goal-editor": GoalEditor,
  accounts: Sidebar, inbox: Inbox, "inbox-button": InboxButton, "account-menu": AccountMenu,
  "panel-bar": PanelBar, "panel-toggle": PanelToggle, "find-file": FileFinder, "checkout-menu": CheckoutMenu,
  handoff: Handoff, "review-diff": ReviewDiff, "ledger-week": LedgerWeek, settings: Settings,
  "quick-replies": QuickReplies, sessions: SessionFinder, usage: UsageDialog,
};

export default class Relevo extends View {
  init(_props, cx) {
    const role = props()?.role ?? "accounts";
    const snapshot = props()?.snapshotPreview === true;
    const preview = props()?.syntheticPreview === true || snapshot;
    this.syntheticPreview = preview;
    const Part = preview
      ? ({ inbox: Inbox, accounts: Sidebar, "inbox-button": InboxButton, "panel-toggle": PanelToggle, "panel-bar": PanelBar }[role] ??
        (snapshot ? ({ "snapshot-detail": SnapshotDetail }[role] ?? SnapshotBanner) : PREVIEW_ROLES[role] ?? PREVIEW_ROLES["preview-banner"]))
      : ROLES[role] ?? Sidebar;
    this.part = new Part();
    this.part.init?.(snapshot ? { ...props(), syntheticPreview: true } : props(), cx);
    // Preview roles never start account watchers, usage scans, or command listeners.
    if (preview) return;
    cx.spawn(async (cx) => {
      await loadKeys();
      cx.notify();
    });
    // keys.json "relevo.<command>"; only the sidebar copy listens, so each runs once.
    if (role === "accounts") {
      cx.spawn(async (cx) => {
        for (;;) this.command(await nextCommand(), cx);
      });
    }
  }

  command(name, cx) {
    if (this.syntheticPreview) return;
    if (name === "goals") { setShared(GOAL_MODE, true); focusInbox(); }
    else if (name === "classic-inbox") { setShared(GOAL_MODE, false); focusInbox(); }
    else if (name === "goal-new") openGoal();
    else if (name.startsWith("goal-focus-")) { setShared(GOAL_MODE, true); setShared(GOAL_SCOPE, name.slice(11)); focusInbox(); }
    else if (name.startsWith("goal-")) openGoal(name.slice(5));
    else if (name === "find-file") openFinder();
    else if (name === "focus-next") this.part.cycleFocus(cx);
    else if (name === "next-waiting") nextWaiting();
    else if (name === "handoff") openHandoff();
    else if (name === "ledger-week") openWeek();
    else if (name === "checkouts") cx.spawn(async () => {
      await openCheckoutsHere();
    });
    else if (name === "settings") openSettings();
    else if (name === "usage") openUsage();
    else if (name === "usage-scan") this.part.readTokens?.(cx);
    else if (name === "quick-reply") openReplies();
    else if (name === "sessions") cx.spawn(async () => { await openSessions(); });
    else if (name.startsWith("quick-reply-")) openReplies(name.slice(12));
    else if (name.startsWith("handoff-from-")) handoffFrom(name.slice(13));
    else if (name.startsWith("handoff-agent-")) openHandoff(name.slice(14));
    else if (name.startsWith("handoff-close-")) closeHandedOff(...name.slice(14).split(":"));
    else if (name === "review") cx.spawn(async () => { await openReview(); });
    else if (name === "open-pr") cx.spawn(async () => { await openPR(); });
    else if (name === "respond-pr") cx.spawn(async () => { await respondPR(); });
    else if (name.startsWith("worktree-")) worktrees(name.slice(9));
    else if (name === "panel-inbox") focusInbox();
    else if (name.startsWith("panel-")) showPanel(name.slice(6));
    else if (name.startsWith("launch-")) this.part.launch(name.slice(7));
  }

  async close(cx) {
    await this.part.close?.(cx);
  }

  render(cx) {
    return this.part.render(cx);
  }
}
