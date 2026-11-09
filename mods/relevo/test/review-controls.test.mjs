import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, find, click, text } from './fake/ui.mjs';
import { diffRows, lineComment, fileComment } from '../lib/diff.js';
const { ReviewDiff } = await import('../review.js');
beforeEach(resetFake);
function review() {
  const v = new ReviewDiff(), cx = fakeCx(); v.init({}, cx); v.key = '/synthetic';
  v.open = { path: 'a.js' }; v.files = [v.open, { path: 'b.js' }];
  v.hashes = new Map([['a.js', 'aaa'], ['b.js', 'bbb']]);
  v.rows = diffRows(['@@ -1,1 +1,2 @@', ' first', '+second']);
  return { v, cx };
}
test('Escape and Cancel discard the draft while retaining saved comments', () => {
  for (const action of ['escape', 'cancel']) {
    const { v, cx } = review(), saved = lineComment('a.js', v.rows, 1, 1, 'Keep this');
    v.setComments([saved]); v.edit({ start: 1, end: 1 }, cx); v.input.set_value('Unsubmitted replacement');
    if (action === 'escape') v.render().handlers.on_key_up({ key: 'escape' }, cx);
    else click(find(v.render(), 'rv-comment-cancel'), cx);
    assert.equal(v.editing, null); assert.equal(v.input.value(), ''); assert.deepEqual(v.comments, [saved]);
    assert.equal(find(v.render(), 'rv-comment-editor'), null); assert.deepEqual(fake.execs, []); v.close();
  }
});
test('Delete removes exactly the selected line, range or file comment without sending', () => {
  for (const target of [{ start: 1, end: 1 }, { start: 1, end: 2 }, 'file']) {
    const { v, cx } = review(), other = fileComment('b.js', 'Keep other file');
    const saved = target === 'file' ? fileComment('a.js', 'Remove') : lineComment('a.js', v.rows, target.start, target.end, 'Remove');
    v.setComments([saved, other]); v.edit(target, cx); click(find(v.render(), 'rv-comment-delete'), cx);
    assert.deepEqual(v.comments, [other]); assert.deepEqual(fake.stored['relevo.review.notes'][v.key], [other]);
    assert.equal(v.editing, null); assert.deepEqual(fake.execs, []); v.close();
  }
});
test('empty Enter is not an implicit deletion and Save persists a nonempty edit', () => {
  const { v, cx } = review(), saved = fileComment('a.js', 'Original'); v.setComments([saved]); v.edit('file', cx);
  v.input.set_value('  '); v.save(cx); assert.deepEqual(v.comments, [saved]); assert.equal(v.editing, 'file');
  v.input.set_value('Updated'); click(find(v.render(), 'rv-comment-save'), cx);
  assert.equal(v.comments[0].text, 'Updated'); assert.equal(v.editing, null); v.close();
});
test('new comments have no Delete button and deferred focus never targets a cancelled editor', () => {
  const { v, cx } = review(); let focused = 0; v.input.focus = () => focused++;
  v.edit('file', cx); assert.equal(find(v.render(), 'rv-comment-delete'), null);
  v.cancelEdit(cx); cx.timers.filter((timer) => timer.ms === 30).forEach((timer) => timer.fn(cx));
  assert.equal(focused, 0); assert.deepEqual(v.comments, []); v.close();
});
test('selected-file and bulk viewed controls update marks, not checkpoints, and changes invalidate marks', () => {
  const { v, cx } = review(); fake.stored['relevo.review.viewed'] = { '/other': { 'c.js': 'ccc' } };
  click(find(v.render(), 'rv-file-viewed'), cx); assert.equal(v.viewed('a.js'), true); assert.equal(v.viewed('b.js'), false);
  click(find(v.render(), 'rv-mark-all-viewed'), cx); assert.match(text(v.header({})), /2 of 2 viewed/);
  assert.equal(find(v.render(), 'rv-mark-all-viewed').isDisabled, true);
  v.hashes.set('a.js', 'changed'); assert.equal(v.viewed('a.js'), false); assert.equal(v.viewed('b.js'), true);
  assert.deepEqual(fake.stored['relevo.review.viewed']['/other'], { 'c.js': 'ccc' });
  assert.equal(v.seenMark(), null); assert.deepEqual(fake.execs, []); v.close();
});
test('failed checkpoint writes do not claim that a checkpoint was saved', async () => {
  const { v, cx } = review(); v.snapshot = async () => 'abc'; fake.exec = () => ({ code: 1 });
  await v.markSeen(cx); assert.equal(v.seenMark(), null); assert.match(v.note, /Could not save/); v.close();
});
test('sending remains disabled while a saved comment has an unfinished edit', () => {
  const { v, cx } = review(); v.target = () => ({ address: 'synthetic-agent' }); v.setComments([fileComment('a.js', 'Saved')]);
  assert.equal(find(v.render(), 'rv-send').isDisabled, false); v.edit('file', cx); v.input.set_value('Unfinished');
  assert.equal(find(v.render(), 'rv-send').isDisabled, true); v.cancelEdit(cx);
  assert.equal(find(v.render(), 'rv-send').isDisabled, false); assert.deepEqual(fake.execs, []); v.close();
});
