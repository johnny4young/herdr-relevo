import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find, click, text } from './fake/ui.mjs';
const { Inbox } = await import('../inbox.js');
const { GoalEditor } = await import('../goals-editor.js');
const { AccountMenu } = await import('../account-menu.js');
const { GOAL_MODE } = await import('../inbox-goals.js');
const { newGoal, saveGoal, emptyGoals } = await import('../lib/goals.js');
const { goalsPath, readGoals } = await import('../goals-store.js');
const { button } = await import('../ui.js');
const { theme } = await import('./fake/herdr.mjs');
const pr = { url: 'https://github.com/acme/app/pull/1', number: 1, repo: 'acme/app', title: 'Search', reasons: [], skills: ['review'], updatedAt: new Date().toISOString() };
beforeEach(resetFake);
async function inbox() {
  const v = new Inbox(), cx = fakeCx(); v.init({}, cx); await flush();
  v.mine = [pr]; v.clones[pr.repo] = '/work/app';
  v.goalDoc = saveGoal(emptyGoals(), newGoal('g', 'Ship search', [`pr:${pr.url}`]), 0);
  fake.stored[GOAL_MODE] = true; v.h.is_focused = () => true; v.render(cx);
  return { v, cx };
}

test('buttons expose native activation, keyboard focus and a useful accessible name', () => {
  const b = button(theme(), 'help', '?', () => {}, { accessibleLabel: 'Keyboard help', tip: 'Show shortcuts' });
  assert.equal(b.kind, 'button'); assert.equal(b.tabIndex, 0);
  assert.equal(b.accessibleLabel, 'Keyboard help'); assert.equal(b.hasFocusStyle, true);
  const disabled = button(theme(), 'off', 'Unavailable', () => assert.fail(), { disabled: true, tip: 'Clone the repository first' });
  assert.equal(disabled.tabStop, false); assert.equal(disabled.isDisabled, true);
  assert.equal(disabled.handlers.on_click, undefined);
});

test('queue shortcuts never launch a card action from a focused descendant or OS chord', async () => {
  const { v, cx } = await inbox(); let ran = 0; v.nav = [{ id: 'x', go: () => ran++ }]; v.sel = 'x';
  v.h.is_focused = () => false; v.navKey({ key: 'enter' }, cx);
  v.h.is_focused = () => true; v.navKey({ key: 'enter', modifiers: { platform: true } }, cx);
  assert.equal(ran, 0); v.navKey({ key: 'enter' }, cx); assert.equal(ran, 1);
});

test('G reaches a goal behind blockers, E opens context, and S opens choices without running a skill', async () => {
  const { v, cx } = await inbox();
  v.navKey({ key: 'g' }, cx); assert.equal(v.sel, 'goal-g');
  v.navKey({ key: 'e' }, cx); assert.equal(fake.overlays.at(-1).props.goalId, 'g');
  v.sel = `pr-${pr.url}`; const before = fake.execs.length;
  v.navKey({ key: 's' }, cx);
  assert.equal(fake.overlays.at(-1).props.role, 'account-menu');
  assert.equal(fake.overlays.at(-1).props.pr.url, pr.url);
  assert.equal(fake.execs.length, before);
  const count = fake.overlays.length; delete v.clones[pr.repo]; v.navKey({ key: 's' }, cx);
  assert.equal(fake.overlays.length, count);
});

test('folds and skill launchers are native keyboard controls', async () => {
  const { v, cx } = await inbox(); v.drafts = [{ ...pr, isDraft: true }]; v.mine = [];
  let tree = v.render(cx); const fold = find(tree, 'goal-drafts-g');
  assert.equal(fold.kind, 'button'); assert.match(fold.accessibleLabel, /Expand/);
  click(fold, cx); tree = v.render(cx);
  assert.equal(find(tree, `source-skills-pr:${pr.url}`).kind, 'button');
  assert.equal(find(tree, `ready-${pr.url}`).kind, 'button');
});

test('editor sections retain all edits; long text wraps; Command-S saves without executing work', async () => {
  const e = new GoalEditor(), cx = fakeCx(); e.init({}, cx); await flush();
  e.fields.title.set_value('Keyboard review'); e.fields.criteria.set_value('All controls work without a pointer.');
  let tree = e.render(); assert.equal(find(tree, 'goal-field-title').kind, 'input');
  assert.equal(find(tree, 'goal-field-criteria').kind, 'textarea');
  assert.equal(find(tree, 'goal-field-decision'), null);
  assert.equal(find(tree, 'goal-field-owner'), null);
  click(find(tree, 'goal-review-notes-toggle'), cx); tree = e.render();
  assert.equal(find(tree, 'goal-field-decision').kind, 'textarea');
  click(find(tree, 'goal-panel-ownership'), cx); e.fields.owner.set_value('Johnny');
  tree = e.render(); assert.equal(find(tree, 'goal-field-owner').accessibleLabel, 'Human owner');
  assert.equal(find(tree, 'goal-field-group-owner').accessibleLabel, 'Human owner');
  tree.handlers.on_key_down({ key: 's', modifiers: { platform: true } }, cx); await flush();
  const saved = (await readGoals()).doc.goals[0];
  assert.equal(saved.owner, 'Johnny'); assert.equal(saved.criteria, 'All controls work without a pointer.');
  assert.deepEqual(fake.execs, []); assert.ok(fake.files[goalsPath()]); e.close();
});

test('new mission leads with its title and acceptance criteria while saved decisions remain editable', async () => {
  const fresh = new GoalEditor(), freshCx = fakeCx(); fresh.init({}, freshCx); await flush();
  let tree = fresh.render();
  assert.match(text(tree), /Brief/); assert.match(text(tree), /Outcomes/);
  assert.ok(find(tree, 'goal-field-title')); assert.ok(find(tree, 'goal-field-criteria'));
  assert.equal(find(tree, 'goal-field-decision'), null); assert.equal(find(tree, 'goal-field-recommendation'), null);
  assert.equal(find(tree, 'goal-resolve-decision'), null); assert.equal(find(tree, 'goal-review-steps'), null);
  fresh.close();

  const existing = { ...newGoal('g-saved', 'Saved mission'), decision: 'Accept the current result?',
    recommendation: 'Keep the change focused.', criteria: 'Search returns matching items.' };
  fake.files[goalsPath()] = JSON.stringify(saveGoal(emptyGoals(), existing, 0));
  fake.props = { goalId: existing.id, panel: 'decision', overlay: 'goal-editor' };
  const e = new GoalEditor(), cx = fakeCx(); e.init({}, cx); await flush();
  tree = e.render();
  assert.ok(find(tree, 'goal-field-decision')); assert.ok(find(tree, 'goal-field-recommendation'));
  e.fields.decision.set_value('Accept after checking the empty state.');
  e.save(cx); await flush();
  const saved = (await readGoals()).doc.goals[0];
  assert.equal(saved.decision, 'Accept after checking the empty state.');
  assert.equal(saved.recommendation, 'Keep the change focused.');
  assert.equal(saved.criteria, 'Search returns matching items.');
  e.close();
});

test('validation of a folded decision opens the notes panel before focusing the field', async () => {
  const e = new GoalEditor(), cx = fakeCx(); e.init({}, cx); await flush();
  e.fields.title.set_value('A mission'); e.fields.decision.set_value('x'.repeat(2001));
  let focused = 0; e.fields.decision.focus = () => { focused++; };
  e.save(cx);
  assert.equal(e.panel, 'decision'); assert.equal(e.reviewNotesOpen, true);
  assert.ok(find(e.render(), 'goal-field-decision'));
  cx.timers.at(-1).fn(cx); assert.equal(focused, 1); assert.deepEqual(fake.execs, []); e.close();
});

test('account picker preserves native selection and rejects duplicate skill launches', async () => {
  fake.props = { pr, current: 'personal', skill: 'review', folder: '/work/app' };
  const menu = new AccountMenu(), cx = fakeCx(); menu.init({}, cx); await flush();
  const tree = menu.render();
  assert.equal(find(tree, 'menu-acct-personal').kind, 'button');
  assert.equal(find(tree, 'menu-skill-review').kind, 'button');
  menu.runSkill('review', cx); menu.runSkill('review', cx); await flush();
  assert.equal(fake.closedOverlays.length, 1);
});

test('goal editor distinguishes loading from saving and locks fields until data arrives', async () => {
  let resolveRead;
  fake.read = (path) => path === goalsPath() ? new Promise((resolve) => { resolveRead = resolve; }) : null;
  const e = new GoalEditor(), cx = fakeCx(); e.init({}, cx); await flush();
  let tree = e.render();
  assert.equal(find(tree, 'goal-save').items[0], 'Loading…');
  assert.equal(find(tree, 'goal-field-title'), null);
  assert.equal(find(tree, 'goal-field-decision'), null);
  assert.ok(find(tree, 'goal-loading'));
  assert.equal(find(tree, 'goal-cancel').isDisabled, false);
  resolveRead(null); await flush(); tree = e.render();
  assert.equal(find(tree, 'goal-save').items[0], 'Save');
  assert.equal(find(tree, 'goal-field-title').isDisabled, false);
  assert.equal(find(tree, 'goal-field-criteria').kind, 'textarea');
  assert.equal(find(tree, 'goal-field-decision'), null);
  assert.equal(find(tree, 'goal-loading'), null);
  e.close();
});

test('closing during initial load never touches released inputs or schedules late focus', async () => {
  let resolveRead;
  fake.read = (path) => path === goalsPath() ? new Promise((resolve) => { resolveRead = resolve; }) : null;
  const e = new GoalEditor(), cx = fakeCx(); e.init({}, cx); await flush();
  e.close();
  let touched = 0;
  for (const f of Object.values(e.fields)) f.set_value = () => { touched++; };
  const notified = cx.notified;
  resolveRead(null); await flush();
  assert.equal(touched, 0); assert.equal(cx.notified, notified);
  assert.equal(cx.timers.filter((t) => t.ms === 30).length, 0);
});

test('deferred title focus cannot target a closed editor or a different section', async () => {
  const e = new GoalEditor(), cx = fakeCx(); e.init({}, cx); await flush();
  const focus = cx.timers.find((t) => t.ms === 30); let focused = 0;
  e.fields.title.focus = () => { focused++; };
  e.panel = 'plan'; focus.fn(cx); assert.equal(focused, 0);
  e.panel = 'decision'; e.close(); focus.fn(cx); assert.equal(focused, 0);
});

test('an accepted save finishes once after close without closing another overlay or notifying a disposed editor', async () => {
  fake.props = { overlay: 'own-overlay' };
  const e = new GoalEditor(), cx = fakeCx(); e.init({}, cx); await flush();
  e.fields.title.set_value('Deferred save');
  let resolveWrite, writes = 0;
  fake.write = async (path, body) => { writes++; await new Promise((resolve) => { resolveWrite = resolve; }); fake.files[path] = body; };
  e.save(cx); await flush();
  assert.equal(find(e.render(), 'goal-save').items[0], 'Saving…');
  assert.equal(find(e.render(), 'goal-field-title').isDisabled, true);
  e.save(cx); assert.equal(writes, 1);
  e.close(); fake.props = { overlay: 'different-overlay' }; const notified = cx.notified;
  resolveWrite(); await flush();
  assert.equal((await readGoals()).doc.goals[0].title, 'Deferred save');
  assert.deepEqual(fake.closedOverlays, []); assert.equal(cx.notified, notified);
  e.save(cx); await flush(); assert.equal(writes, 1);
});

test('linking after dismissal preserves the submitted source and avoids disposed UI work', async () => {
  const goal = saveGoal(emptyGoals(), newGoal('existing', 'Existing goal'), 0).goals[0];
  fake.files[goalsPath()] = JSON.stringify({ ...emptyGoals(), goals: [goal] });
  fake.props = { source: { key: 'pr:https://example.com/pull/2' }, overlay: 'link-overlay' };
  const e = new GoalEditor(), cx = fakeCx(); e.init({}, cx); await flush();
  let resolveWrite;
  fake.write = async (path, body) => { await new Promise((resolve) => { resolveWrite = resolve; }); fake.files[path] = body; };
  e.linkExisting(goal, cx); await flush(); e.close(); const notified = cx.notified;
  fake.props = { source: { key: 'pr:https://example.com/pull/3' }, overlay: 'other-overlay' };
  resolveWrite(); await flush();
  assert.deepEqual((await readGoals()).doc.goals[0].sources, ['pr:https://example.com/pull/2']);
  assert.deepEqual(fake.closedOverlays, []); assert.equal(cx.notified, notified);
});

test('a failed load after dismissal stays silent and close releases handles only once', async () => {
  let rejectRead;
  fake.read = () => new Promise((_resolve, reject) => { rejectRead = reject; });
  const e = new GoalEditor(), cx = fakeCx(); e.init({}, cx); await flush();
  let released = 0; e.fields.title.release = () => { released++; };
  e.close(); e.close(); const notified = cx.notified;
  rejectRead(Error('Synthetic read error')); await flush();
  assert.equal(released, 1); assert.equal(cx.notified, notified); assert.equal(e.error, undefined);
});

test('missing goal title returns to Decision with a useful error and no persistence attempt', async () => {
  const e = new GoalEditor(), cx = fakeCx(); e.init({}, cx); await flush();
  e.panel = 'ownership'; e.fields.owner.set_value('Draft owner'); e.fields.criteria.set_value('Keep this draft');
  let reads = 0; fake.read = async () => { reads++; return null; };
  e.save(cx); await flush();
  assert.equal(e.panel, 'decision'); assert.equal(e.error, 'Enter a goal title before saving.');
  assert.equal(e.busy, false); assert.equal(reads, 0); assert.deepEqual(fake.execs, []);
  assert.equal(e.fields.owner.value(), 'Draft owner'); assert.equal(e.fields.criteria.value(), 'Keep this draft');
  assert.equal(find(e.render(), 'goal-save-error').items[0], e.error);
  assert.deepEqual(fake.files, {}); assert.deepEqual(fake.closedOverlays, []); e.close();
});

test('blank plan step returns to Plan, preserves every draft and focuses the exact step', async () => {
  const e = new GoalEditor(), cx = fakeCx(); e.init({}, cx); await flush();
  e.fields.title.set_value('Ship safely'); e.fields.decision.set_value('Keep this decision');
  e.panel = 'plan'; click(find(e.render(), 'goal-add-step'), cx);
  let focuses = 0; const step = e.steps[0]; step.input.focus = () => { focuses++; };
  step.input.set_value('   '); e.panel = 'ownership'; e.save(cx); await flush();
  assert.equal(e.panel, 'plan'); assert.equal(e.error, 'Enter an expected outcome for plan step 1.');
  assert.equal(e.steps[0], step); assert.equal(e.fields.decision.value(), 'Keep this decision');
  cx.timers.at(-1).fn(cx); assert.equal(focuses, 1);
  assert.equal(fake.files[goalsPath()], undefined); e.close();
});

test('editable text limits explain the field and section before any save', async () => {
  const e = new GoalEditor(), cx = fakeCx(); e.init({}, cx); await flush();
  e.fields.title.set_value('x'.repeat(241)); e.save(cx); await flush();
  assert.equal(e.error, 'Keep the goal title to 240 characters or fewer.');
  e.fields.title.set_value('Within limit'); e.fields.owner.set_value('x'.repeat(2001)); e.save(cx); await flush();
  assert.equal(e.panel, 'ownership'); assert.equal(e.error, 'Keep Human owner to 2000 characters or fewer.');
  e.fields.owner.set_value('Owner'); e.response.set_value('x'.repeat(2001)); e.save(cx); await flush();
  assert.equal(e.panel, 'decision'); assert.equal(e.error, 'Keep decision or feedback to 2000 characters or fewer.');
  assert.equal(fake.files[goalsPath()], undefined); assert.deepEqual(fake.closedOverlays, []); e.close();
});

test('validation focus does not run after dismissal or a section change', async () => {
  const e = new GoalEditor(), cx = fakeCx(); e.init({}, cx); await flush();
  e.save(cx); await flush(); let focuses = 0; e.fields.title.focus = () => { focuses++; };
  const focus = cx.timers.at(-1); e.panel = 'plan'; focus.fn(cx); assert.equal(focuses, 0);
  e.panel = 'decision'; e.close(); focus.fn(cx); assert.equal(focuses, 0);
});

test('correcting a validation error saves the preserved draft once', async () => {
  const e = new GoalEditor(), cx = fakeCx(); e.init({}, cx); await flush();
  e.fields.owner.set_value('Owner'); e.fields.criteria.set_value('All checks pass');
  e.save(cx); await flush(); assert.equal(fake.files[goalsPath()], undefined);
  e.fields.title.set_value('Corrected title'); e.save(cx); await flush();
  const doc = (await readGoals()).doc;
  assert.equal(doc.goals.length, 1); assert.equal(doc.revision, 1);
  assert.equal(doc.goals[0].title, 'Corrected title'); assert.equal(doc.goals[0].owner, 'Owner');
  assert.equal(doc.goals[0].criteria, 'All checks pass'); assert.equal(e.error, null);
  assert.equal(fake.closedOverlays.length, 1); e.close();
});

test('validation focus never touches a removed plan step', async () => {
  const e = new GoalEditor(), cx = fakeCx(); e.init({}, cx); await flush();
  e.fields.title.set_value('Retained draft'); e.panel = 'plan'; click(find(e.render(), 'goal-add-step'), cx);
  const step = e.steps[0]; let focuses = 0; step.input.focus = () => { focuses++; };
  e.save(cx); const focus = cx.timers.at(-1);
  click(find(e.render(), `goal-step-remove-${step.id}`), cx); focus.fn(cx);
  assert.equal(focuses, 0); assert.equal(e.steps.length, 0); e.close();
});

test('editable values at their exact limits remain saveable', async () => {
  const e = new GoalEditor(), cx = fakeCx(); e.init({}, cx); await flush();
  e.fields.title.set_value('t'.repeat(240));
  for (const key of ['owner', 'decision', 'recommendation', 'criteria']) e.fields[key].set_value('x'.repeat(2000));
  e.response.set_value('r'.repeat(2000)); e.panel = 'plan'; click(find(e.render(), 'goal-add-step'), cx);
  e.steps[0].input.set_value('s'.repeat(240)); e.save(cx); await flush();
  const saved = (await readGoals()).doc.goals[0];
  assert.equal(saved.title.length, 240); assert.equal(saved.steps[0].title.length, 240);
  assert.equal(saved.decisions[0].text.length, 2000); assert.equal(e.error, null); e.close();
});
