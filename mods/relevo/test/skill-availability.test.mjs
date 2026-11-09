import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake, theme } from './fake/herdr.mjs';
import { fakeCx, flush, find, click, text } from './fake/ui.mjs';
import { rankSkills } from '../lib/prmenu.js';
const { Inbox } = await import('../inbox.js');
const { PrViews } = await import('../inbox-prs.js');
const { AccountMenu } = await import('../account-menu.js');
const { launchSkill, LAUNCHED } = await import('../skills.js');
const pr = { url: 'https://github.com/acme/app/pull/1', number: 1, repo: 'acme/app', title: 'Search', headRefName: 'search', reasons: [], skills: ['retired'], updatedAt: new Date().toISOString() };
beforeEach(resetFake);

test('ranking tolerates a missing recommendation and never invents a replacement', () => {
  const skills = { review: { name: 'review' }, fix: { name: 'fix-ci' } };
  assert.deepEqual(rankSkills('retired', skills, {}), []);
  assert.deepEqual(rankSkills('retired', skills, { review: 3 }), [{ verb: 'review', uses: 3 }]);
  assert.deepEqual(rankSkills('retired', {}, { retired: 99 }), []);
  assert.deepEqual(rankSkills('toString', skills, {}), []);
});

test('a missing skill shows an inert primary control and preserves the picker', () => {
  const view = new PrViews(), cx = fakeCx(); view.clones = { [pr.repo]: '/work/app' }; view.quotas = {};
  const tree = view.skillButton(theme(), pr, 'retired', true), primary = find(tree, `run-retired-${pr.url}`);
  assert.equal(primary.isDisabled, true); assert.equal(primary.tabStop, false);
  assert.equal(primary.handlers.on_click, undefined); assert.match(text(primary), /Skill unavailable/);
  click(find(tree, `pick-retired-${pr.url}`), cx);
  assert.equal(fake.overlays.at(-1).props.skill, 'retired'); assert.deepEqual(fake.runs, []);
});

test('unknown or inherited skill names cannot launch or overwrite a previous receipt', () => {
  const old = { [pr.url]: { skill: 'review', tab: 'original', at: 1 } }; fake.stored[LAUNCHED] = old;
  assert.doesNotThrow(() => launchSkill(pr, 'retired', 'personal', '/work/app'));
  assert.doesNotThrow(() => launchSkill(pr, 'toString', 'personal', '/work/app'));
  assert.equal(fake.stored[LAUNCHED], old); assert.deepEqual(fake.runs, []); assert.deepEqual(fake.execs, []);
  assert.equal(fake.notices.length, 2); assert.equal(fake.notices[0].title, 'Skill unavailable');
});

test('the account menu explains missing configuration without claiming installation or launching', async () => {
  fake.props = { pr, current: 'personal', skill: 'retired', folder: '/work/app' };
  const menu = new AccountMenu(), cx = fakeCx(); menu.init({}, cx); await flush();
  const tree = menu.render();
  assert.match(text(find(tree, 'menu-skill-unavailable')), /not configured/);
  assert.equal(find(tree, 'menu-session').isDisabled, false);
  const before = fake.execs.length; menu.runSkill('retired', cx); menu.runSkill('toString', cx); await flush();
  assert.equal(fake.execs.length, before); assert.deepEqual(fake.runs, []); assert.deepEqual(fake.closedOverlays, []);
});

test('a removed historical skill still shows the current agent status', () => {
  const view = new PrViews(); fake.stored[LAUNCHED] = { [pr.url]: { skill: 'retired', at: 1 } };
  assert.equal(view.agentLine(pr, { address: 't-test', status: 'blocked' }), 'Previous skill is waiting for you');
  assert.equal(view.agentLine(pr, { address: 't-test', status: 'working' }), 'Previous skill working…');
  assert.match(view.agentLine(pr, null), /Previous skill ran/);
});

test('a PR with a missing skill keeps review, open and addressed controls', async () => {
  const view = new Inbox(), cx = fakeCx(); view.init({}, cx); await flush();
  view.mine = [pr]; view.clones[pr.repo] = '/work/app';
  const tree = view.render(cx);
  assert.ok(find(tree, `pr-${pr.url}`)); assert.ok(find(tree, `review-pr-${pr.url}`));
  assert.ok(find(tree, `open-${pr.url}`)); assert.ok(find(tree, `addressed-${pr.url}`));
  assert.equal(find(tree, `run-retired-${pr.url}`).isDisabled, true);
});
