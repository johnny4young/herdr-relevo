import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract, text } from '../snapshot-data.mjs';
import { profile } from '../snapshot-herdr.mjs';
const fixture = () => ({ 'herdr-app': { value: { spaces: [{ id: 's1', name: '$(touch /tmp/unsafe)', folder: '/secret/private/repo', tabs: [{ id: 'tab1', name: 'Tab', root: { type: 'row', children: [{ type: 'block', content: { terminal: 't1' } }] } }] }] } } });
const first = (out) => out.spaces[0].tabs[0].terminals[0];
test('extractor allowlists metadata, never executable or sensitive fields', () => {
  const out = extract(fixture(), { 1: { address: 't1', title: 'Title\x1b\n', cwd: '/secret/private/repo', reported: true, status: { state: 'blocked', app: 'codex', msg: 'NEVER_COPY' }, status_ms: 12, argv: ['NEVER_COPY'], restart_env: { TOKEN: 'NEVER_COPY' }, labels: { secret: 'NEVER_COPY' }, screen: 'NEVER_COPY' } });
  assert.doesNotMatch(JSON.stringify(out), /NEVER_COPY|\/secret/);
  assert.deepEqual([first(out).status, first(out).agentApp, first(out).title], ['blocked', 'codex', 'Title']);
  for (const k of ['goal', 'responsible', 'criteria']) assert.equal(first(out)[k], null);
});
test('unknown status, app and malformed timestamp stay unknown', () => {
  const t = first(extract(fixture(), { 1: { address: 't1', reported: true, status: { state: 'untrusted', app: 'secret' }, status_ms: true } }));
  assert.deepEqual([t.status, t.agentApp, t.statusAt], [null, null, null]);
});
test('source code stays literal text', () => {
  const out = extract(fixture(), {});
  assert.equal(out.spaces[0].title, '$(touch /tmp/unsafe)');
  assert.deepEqual(out.spaces[0].tabs[0].root.children[0], { type: 'terminal', sourceId: 't1' });
});
test('unnamed spaces/tabs preserve native fallback provenance', () => {
  const docs = fixture(), s = docs['herdr-app'].value.spaces[0]; s.name = ''; s.tabs[0].name = ''; s.folder = '/Users/example';
  let result = extract(docs, { 1: { address: 't1', title: 'Fix navigation', last_cwd: '/private/code/current-repo' } }).spaces[0];
  assert.deepEqual([result.title, result.titleSource, result.tabs[0].title, result.tabs[0].titleSource], ['current-repo', 'terminal-folder', 'Fix navigation', 'terminal-title']);
  result = extract(docs, { 1: { address: 't1', last_cwd: '/private/code/current-repo' } }).spaces[0];
  assert.equal(result.tabs[0].titleSource, 'terminal-folder');
  result = extract(docs, {}).spaces[0];
  assert.deepEqual([result.title, result.titleSource, result.tabs[0].titleSource], ['example', 'folder', 'unknown']);
});
test('credential-shaped metadata is suppressed before truncation', () => {
  for (const value of ['sk-FAKE_TEST_NOT_A_REAL_KEY', 'ghp_FAKE_TEST_ONLY_1234', 'github_pat_FAKE_TEST_ONLY_1234', 'Bearer FAKE_TEST_ONLY', 'password=FAKE_TEST_ONLY', 'token: FAKE_TEST_ONLY', 'api_key=FAKE_TEST_ONLY', 'https://fake-user:fake-password@example.invalid/']) {
    assert.equal(text(`Task ${value}`), 'Contenido sensible omitido');
    assert.equal(text(`${'x'.repeat(300)} ${value}`), 'Contenido sensible omitido');
  }
  assert.equal(text('Review navigation /example/project'), 'Review navigation /example/project');
});
test('export drops credential-shaped workspace and terminal titles', () => {
  const docs = fixture(); docs['herdr-app'].value.spaces[0].name = 'token=FAKE_TEST_ONLY';
  assert.doesNotMatch(JSON.stringify(extract(docs, { 1: { address: 't1', title: 'Bearer FAKE_TEST_ONLY' } })), /FAKE_TEST_ONLY/);
});
test('runtime cannot read snapshot source; extractor denies network and child processes', () => {
  assert.doesNotMatch(profile(false), /default\/docs.json/);
  assert.match(profile(true), /default\/docs.json/);
  assert.match(profile(true), /\(deny process-fork\)/);
  assert.match(profile(false), /\(deny network\*\)/);
});
