import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake, calls } from './fake/herdr.mjs';
import { fakeCx, flush, find, text, click } from './fake/ui.mjs';
const { emptyGoals, newGoal, saveGoal, parseGoals, groupSources, evidenceState } = await import('../lib/goals.js');
const { goalsPath, writeGoal, readGoals } = await import('../goals-store.js');
const { GoalEditor } = await import('../goals-editor.js');
const { Inbox } = await import('../inbox.js');
const { GOAL_MODE } = await import('../inbox-goals.js');

const a = 'a'.repeat(40), b = 'b'.repeat(40);
const key = 'pr:https://github.com/acme/app/pull/1';
const goal = (id = 'g1', sources = [key]) => ({ ...newGoal(id, 'Usable search', sources), owner: 'Human', priority: 1 });
const commit = (g = goal()) => saveGoal(emptyGoals(), g, 0);
beforeEach(() => { resetFake(); fake.write = async (path, value, expected) => {
  if ((fake.files[path] ?? null) !== expected) throw Error('stale file');
  fake.files[path] = value;
}; });

test('metadata survives reopen and stale writers cannot overwrite newer human edits', async () => {
  await writeGoal(goal(), 0);
  const first = (await readGoals()).doc.goals[0];
  await writeGoal({ ...first, decision: 'Keep query?' }, 1);
  await assert.rejects(writeGoal({ ...first, title: 'Old title' }, 1), /changed/);
  assert.equal((await readGoals()).doc.goals[0].decision, 'Keep query?');
});

test('CAS failure and corrupt input preserve bytes and report failure', async () => {
  fake.files[goalsPath()] = '{broken';
  await assert.rejects(writeGoal(goal(), 0));
  assert.equal(fake.files[goalsPath()], '{broken');
  fake.files[goalsPath()] = null;
  fake.write = async () => { throw Error('disk full'); };
  await assert.rejects(writeGoal(goal(), 0), /disk full/);
  assert.equal(fake.files[goalsPath()], null);
});

test('unsupported schemas, duplicate work and oversize content fail closed', () => {
  assert.throws(() => parseGoals('{"version":2}'));
  assert.throws(() => saveGoal(commit(), goal('g2'), 0), /Duplicate/);
  assert.throws(() => saveGoal(emptyGoals(), { ...goal(), title: 'x'.repeat(241) }, 0));
});

test('one source appears once; waiting work takes priority over declared priority', () => {
  let doc = commit({ ...goal('g1'), priority: 0 });
  doc = saveGoal(doc, { ...goal('g2', ['local:t2']), priority: 3 }, 0);
  const grouped = groupSources(doc, [{ key, blocked: false }, { key, blocked: false }, { key: 'local:t2', blocked: true }, { key: 'local:t3' }]);
  assert.deepEqual(grouped.groups.map((g) => g.goal.id), ['g2', 'g1']);
  assert.equal(grouped.groups[1].items.length, 1);
  assert.equal(grouped.unlinked.length, 1);
});

test('evidence requires the same source and exact revision, with explicit freshness', () => {
  const e = { source: key, revision: a, kind: 'video', url: 'https://example.com/demo', label: 'Demo' };
  assert.match(evidenceState(e, [{ key, revision: a }], true), /Matches/);
  assert.match(evidenceState(e, [{ key, revision: b }], true), /Outdated/);
  assert.equal(evidenceState(e, [{ key, revision: a }], false), 'Unverified');
  assert.equal(evidenceState(e, [{ key: 'other', revision: a }], true), 'Unverified');
  assert.throws(() => commit({ ...goal(), evidence: [{ ...e, url: 'javascript:alert(1)' }] }));
});

test('saving intent never sends messages, approves or merges', async () => {
  fake.props = { source: { key, title: 'PR 1', revision: a } };
  const editor = new GoalEditor(), cx = fakeCx(); editor.init({}, cx); await flush();
  editor.fields.title.set_value('Better search'); editor.response.set_value('Keep the query visible');
  editor.save(cx); editor.save(cx); await flush();
  const doc = (await readGoals()).doc;
  assert.equal(doc.goals.length, 1); assert.equal(doc.goals[0].decisions.length, 1);
  assert.deepEqual(doc.goals[0].decisions[0].revisions, [{ source: key, revision: a }]);
  assert.deepEqual(fake.execs, []);
});

test('attaching evidence rechecks HEAD and a changed PR never receives that evidence', async () => {
  fake.props = { source: { key, title: 'PR 1', revision: a } };
  fake.exec = () => ({ stdout: JSON.stringify({ headRefOid: b }) });
  const editor = new GoalEditor(), cx = fakeCx(); editor.init({}, cx); await flush();
  editor.fields.title.set_value('Better search'); editor.link.set_value('https://example.com/demo');
  editor.save(cx); await flush();
  assert.match(editor.error, /PR changed/); assert.equal(fake.files[goalsPath()], undefined);
});

test('leader selectors exclude plain terminals and never launch an agent', async () => {
  fake.terminals = [{ address: 't1', state: 'live' }];
  const editor = new GoalEditor(), cx = fakeCx(); editor.init({}, cx); await flush();
  assert.equal(find(editor.render(), 'goal-lead-t1'), null);
  assert.deepEqual(calls(/^hc run/), []);
});

async function inbox() {
  fake.exec = (cmd) => cmd === 'gh' ? { stdout: JSON.stringify({ data: { viewer: { login: 'me', pullRequests: { nodes: [] } }, search: { nodes: [] } } }) } : null;
  const view = new Inbox(), cx = fakeCx(); view.init({}, cx); await flush();
  return { view, cx };
}

test('objectives use original PR review/actions and classic mode restores its section', async () => {
  const { view, cx } = await inbox();
  view.mine = [{ url: key.slice(3), repo: 'acme/app', number: 1, title: 'Search', reasons: ['CI failing'], skills: [], hot: true, updatedAt: new Date().toISOString(), headRefOid: a }];
  view.clones['acme/app'] = '/work/app';
  fake.stored[GOAL_MODE] = true;
  let tree = view.render(cx);
  assert.ok(find(tree, `pr-${key.slice(3)}`));
  assert.ok(find(tree, `review-pr-${key.slice(3)}`));
  assert.ok(find(tree, `source-link-${key}`));
  click(find(tree, 'inbox-mode-false'), cx);
  tree = view.render(cx);
  assert.match(text(tree), /YOUR PRS/);
  assert.equal(find(tree, `source-link-${key}`), null);
});

test('two blocked agents in one repo retain separate actionable questions', async () => {
  const { view } = await inbox();
  const sources = view.goalSources({ requested: [], mine: [], ready: [], local: [
    { kind: 'blocked', top: '/work/app', agent: { address: 't1' } },
    { kind: 'blocked', top: '/work/app', agent: { address: 't2' } },
  ] });
  assert.equal(sources.length, 2);
});

test('goal keyboard order follows visible priority and hides previous cards as selection advances', async () => {
  const { view, cx } = await inbox();
  view.h.is_focused = () => true;
  const pr = (i) => ({ url: `https://github.com/acme/app/pull/${i}`, repo: 'acme/app', number: i, title: `PR ${i}`, reasons: [], skills: [], updatedAt: new Date().toISOString() });
  view.mine = [pr(1), pr(2), pr(3), pr(4)];
  fake.stored[GOAL_MODE] = true;
  view.render(cx); view.sel = 'pr-https://github.com/acme/app/pull/4';
  const tree = view.render(cx);
  assert.equal(find(tree, 'pr-https://github.com/acme/app/pull/1'), null);
  assert.ok(find(tree, 'pr-https://github.com/acme/app/pull/4'));
});

test('linked quiet PR stays visible but evidence cannot look current after a failed refresh', async () => {
  const { view, cx } = await inbox();
  view.goalDoc = commit({ ...goal(), evidence: [{ source: key, revision: a, kind: "video", label: "Demo", url: "https://example.com/demo" }] });
  view.prsAt = Date.now() / 1000; view.error = "offline";
  view.openPRs = [{ url: key.slice(3), repo: 'acme/app', number: 1, title: 'Quiet PR', headRefOid: a, updatedAt: new Date().toISOString() }];
  fake.stored[GOAL_MODE] = true;
  view.expanded['goal-g1-context'] = true;
  const tree = view.render(cx);
  assert.ok(find(tree, `pr-${key.slice(3)}`));
  assert.match(text(tree), /Unverified/);
  assert.equal(view.goalProjection.groups[0].items.length, 1);
});

test('metadata cap counts UTF-8 bytes so a valid write remains readable by the app', () => {
  const doc = emptyGoals();
  doc.goals = Array.from({ length: 50 }, (_, i) => ({ ...newGoal(`g${i}`, 'Title'), version: 1,
    owner: '界'.repeat(1800), lead: '界'.repeat(1800), decision: '界'.repeat(1800), recommendation: '界'.repeat(1800), criteria: '界'.repeat(1800) }));
  const raw = JSON.stringify(doc);
  assert.ok(raw.length < 700000);
  assert.throws(() => parseGoals(raw), /full/);
});

test('old goals remain editable without a migration; malformed plans fail closed', () => {
  const legacy = goal(); delete legacy.steps; delete legacy.state;
  assert.equal(parseGoals(JSON.stringify(commit(legacy))).goals[0].title, legacy.title);
  for (const changed of [{ state: 'approved' }, { steps: [{ id: 's', title: 'Try it', state: 'guessed' }] },
    { steps: Array(2).fill({ id: 's', title: 'Try it', state: 'todo' }) }]) {
    assert.throws(() => commit({ ...goal(), ...changed }), /Invalid/);
  }
});

test('closing requires resolved decisions and manually validated steps, without external actions', async () => {
  const g = { ...goal(), steps: [{ id: 's', title: 'Keep PR actions', state: 'review' }] };
  await writeGoal(g, 0);
  const before = fake.files[goalsPath()];
  await assert.rejects(writeGoal({ ...g, state: 'completed' }, 1), /validate the plan steps/);
  assert.equal(fake.files[goalsPath()], before);
  await assert.rejects(writeGoal({ ...g, steps: [], state: 'completed', decision: 'Accept?' }, 1), /Resolve the pending decision/);
  await writeGoal({ ...g, state: 'completed', steps: [{ ...g.steps[0], state: 'done' }] }, 1);
  let saved = (await readGoals()).doc.goals[0];
  assert.equal(saved.state, 'completed');
  await writeGoal({ ...saved, state: 'active' }, saved.version);
  saved = (await readGoals()).doc.goals[0];
  assert.equal(saved.state, 'active'); assert.deepEqual(fake.execs, []);
});

test('editor persists plan changes and can discard an accidentally added step', async () => {
  await writeGoal(goal(), 0); fake.props = { goalId: 'g1' };
  const editor = new GoalEditor(), cx = fakeCx(); editor.init({}, cx); await flush();
  editor.panel = 'plan'; click(find(editor.render(), 'goal-add-step'), cx);
  const step = editor.steps[0]; step.input.set_value('Try original review');
  click(find(editor.render(), `goal-step-${step.id}-review`), cx);
  click(find(editor.render(), 'goal-add-step'), cx);
  click(find(editor.render(), `goal-step-remove-${editor.steps[1].id}`), cx);
  editor.save(cx); await flush();
  assert.deepEqual((await readGoals()).doc.goals[0].steps, [{ id: step.id, title: 'Try original review', state: 'review' }]);
  assert.deepEqual(fake.execs, []); editor.close();
});

const samplePR = (number, extra = {}) => ({ url: `https://github.com/acme/app/pull/${number}`, repo: 'acme/app', number,
  title: `PR ${number}`, reasons: [], skills: [], updatedAt: new Date().toISOString(), headRefOid: a, ...extra });

test('linked addressed PR stays folded, retains undo, and returns after new GitHub activity', async () => {
  const { view, cx } = await inbox(), pr = samplePR(1);
  view.goalDoc = commit(); view.mine = [pr]; view.openPRs = [pr];
  const markedAt = Date.parse(pr.updatedAt) / 1000;
  view.addressed[pr.url] = markedAt;
  fake.stored[GOAL_MODE] = true;
  let tree = view.render(cx);
  assert.equal(find(tree, `pr-${pr.url}`), null);
  assert.ok(find(tree, 'goal-addressed-g1'));
  click(find(tree, 'goal-addressed-g1'), cx); tree = view.render(cx);
  assert.ok(find(tree, `undo-${pr.url}`));
  assert.equal(view.nav.filter((n) => n.id === `pr-${pr.url}`).length, 1);
  view.mine = [{ ...pr, updatedAt: new Date((markedAt + 10) * 1000).toISOString() }];
  view.expanded['goal-g1-done'] = false;
  tree = view.render(cx);
  assert.ok(find(tree, `pr-${pr.url}`));
  assert.equal(find(tree, 'goal-addressed-g1'), null);
});

test('drafts keep Ready for review and Open PR and Enter does not launch a review skill', async () => {
  const { view, cx } = await inbox(), pr = samplePR(1, { isDraft: true, skills: ['review'] });
  view.goalDoc = commit(); view.drafts = [pr]; view.openPRs = [pr]; view.clones[pr.repo] = '/work/app';
  fake.stored[GOAL_MODE] = true;
  let tree = view.render(cx);
  assert.equal(find(tree, `pr-${pr.url}`), null);
  click(find(tree, 'goal-drafts-g1'), cx); tree = view.render(cx);
  assert.ok(find(tree, `ready-${pr.url}`)); assert.ok(find(tree, `open-${pr.url}`));
  assert.equal(view.goalProjection.sources.length, 1);
  const before = fake.execs.length;
  view.nav.find((n) => n.id === `pr-${pr.url}`).go(); await flush();
  assert.deepEqual(fake.execs.slice(before), [`open ${pr.url}`]);
});

test('local addressed work keeps undo and review in goal mode', async () => {
  const { view, cx } = await inbox();
  view.local = [{ kind: 'diff', top: '/work/app', agent: { address: 't1', status: 'idle' }, files: 1, add: 2, del: 0 }];
  view.labelling.t1 = '123:1'; fake.stored[GOAL_MODE] = true;
  let tree = view.render(cx);
  assert.equal(find(tree, 'in-t1'), null);
  click(find(tree, 'goal-addressed-unlinked'), cx); tree = view.render(cx);
  assert.ok(find(tree, 'review-t1')); assert.ok(find(tree, 'undo-t1'));
});

test('decision-only goals are keyboard reachable and completed goals never hide active work', async () => {
  const { view, cx } = await inbox();
  view.goalDoc = commit({ ...goal('g1', []), decision: 'Keep existing flow?' });
  view.prsAt = Date.now() / 1000; fake.stored[GOAL_MODE] = true;
  let tree = view.render(cx);
  assert.doesNotMatch(text(tree), /Nothing waiting/);
  assert.match(text(tree), /Decision needed/);
  assert.match(text(tree), /Keep existing flow\?/);
  view.nav.find((n) => n.id === 'goal-g1').go();
  assert.equal(fake.overlays.at(-1).props.goalId, 'g1');
  view.goalDoc = commit({ ...goal(), state: 'completed' }); view.mine = [samplePR(1, { hot: true })];
  tree = view.render(cx);
  assert.ok(find(tree, `pr-${key.slice(3)}`));
  assert.match(text(tree), /Mission completed/);
});

test('observed executors exclude child shells that do not report agent status', async () => {
  const { view, cx } = await inbox();
  fake.agents = [{ address: 't1', status: 'working' }, { address: 't2', status: 'working' }];
  fake.terminals = [{ address: 't1' }, { address: 't2', parent: 't1' }, { address: 't3', parent: 't1' }];
  view.goalDoc = commit({ ...goal(), lead: 't1' }); fake.stored[GOAL_MODE] = true;
  view.expanded['goal-g1-context'] = true;
  assert.match(text(view.render(cx)), /1 observed child agents/);
});

test('mission details fold saved context and evidence while manual decisions and PR actions remain reachable', async () => {
  const { view, cx } = await inbox(), pr = samplePR(1);
  const detail = { ...goal(), decision: 'Approve the search layout?', recommendation: 'Keep the filter visible.',
    criteria: 'Keyboard navigation and every original review control remain available.',
    decisions: [{ text: 'Earlier feedback stays available.', at: new Date().toISOString(), revisions: [] }],
    evidence: [{ source: key, revision: a, kind: 'report', label: 'QA report', url: 'https://example.com/report' }] };
  view.goalDoc = commit(detail); view.mine = [pr]; view.clones[pr.repo] = '/work/app';
  fake.stored[GOAL_MODE] = true; view.prsAt = Date.now() / 1000;
  const original = JSON.stringify(view.goalDoc);
  let tree = view.render(cx), fold = find(tree, 'goal-context-g1');
  assert.ok(fold); assert.equal(fold.kind, 'button'); assert.match(fold.accessibleLabel, /Expand/);
  assert.match(text(fold), /Mission details · 1 evidence/);
  assert.equal(find(tree, 'goal-context-detail-g1'), null);
  assert.ok(find(tree, 'goal-edit-g1'));
  assert.ok(!text(tree).includes(detail.criteria)); assert.ok(!text(tree).includes(detail.decisions[0].text));
  assert.ok(text(tree).includes(detail.decision)); assert.ok(!text(tree).includes(detail.recommendation));
  assert.equal(find(tree, 'goal-evidence-g1-0'), null); assert.ok(find(tree, `review-pr-${pr.url}`));
  const nav = view.nav.map((n) => n.id), execs = [...fake.execs];
  click(fold, cx); tree = view.render(cx);
  assert.ok(find(tree, 'goal-evidence-g1-0')); assert.ok(text(tree).includes(detail.recommendation));
  assert.equal(find(tree, 'goal-record-g1'), null, 'mission details use the existing Edit action instead of duplicating it');
  assert.ok(text(find(tree, 'goal-context-detail-g1')).includes(detail.criteria));
  assert.ok(text(tree).includes(detail.decisions[0].text));
  assert.match(find(tree, 'goal-context-g1').accessibleLabel, /Collapse/);
  assert.equal(fake.stored['relevo.inbox.folds']['goal-g1-context'], true);
  assert.deepEqual(view.nav.map((n) => n.id), nav);
  click(find(tree, 'goal-context-g1'), cx); tree = view.render(cx);
  assert.equal(find(tree, 'goal-context-detail-g1'), null);
  assert.deepEqual(fake.execs, execs); assert.equal(JSON.stringify(view.goalDoc), original);
});

test('empty goal context remains discoverable and fold state is independent for each goal', async () => {
  const { view, cx } = await inbox();
  view.goalDoc = saveGoal(commit(), goal('g2', []), 0); fake.stored[GOAL_MODE] = true;
  let tree = view.render(cx);
  assert.match(text(find(tree, 'goal-context-g1')), /Mission details/);
  assert.doesNotMatch(text(find(tree, 'goal-context-g1')), /recorded/);
  click(find(tree, 'goal-context-g1'), cx); tree = view.render(cx);
  assert.match(text(find(tree, 'goal-context-detail-g1')), /Criteria: Not set/);
  assert.equal(find(tree, 'goal-context-detail-g2'), null);
});
