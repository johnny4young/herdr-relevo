import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentMarkdown } from '../lib/agent-markdown.js';

test('agent markdown keeps formatting but drops HTML, remote images and live links', () => {
  assert.equal(agentMarkdown('Uses `workflowItems` and **keeps** order.'), 'Uses `workflowItems` and **keeps** order.');
  assert.equal(agentMarkdown('See ![chart](https://evil.test/x.png?d=secret)'), 'See chart');
  assert.equal(agentMarkdown('Open [the docs](https://evil.test/login "t")'), 'Open the docs (https://evil.test/login)');
  assert.equal(agentMarkdown('<img src="https://evil.test/p"><b>bold</b>'), 'bold');
  assert.equal(agentMarkdown(null), '');
});

test('reference images, reference links, definitions and multi-line tags are neutralized too', () => {
  assert.equal(agentMarkdown('![a][ref]\n\n[ref]: https://evil.test/x.png?d=secret').trim(), 'a');
  assert.equal(agentMarkdown('![shortcut]\n[shortcut]: https://evil.test/s.png').trim(), 'shortcut');
  assert.equal(agentMarkdown('Go to [docs][1]\n[1]: https://evil.test').trim(), 'Go to docs');
  assert.equal(agentMarkdown('<img\n src="https://evil.test/p">done'), 'done');
});

test('no image syntax survives nesting or tags that rebuild it', () => {
  for (const input of ['![a[b]](https://evil.test/x.png)', '!<b></b>[x](https://evil.test/y.png)', '!<<b>i>[x](https://evil.test/z.png)', '! [x](https://evil.test/w.png)']) {
    assert.doesNotMatch(agentMarkdown(input), /!\s*\[/, input);
    assert.doesNotMatch(agentMarkdown(input), /<|>/, input);
  }
});

test('links with spaced URLs and links that leave a bang behind never become images', () => {
  assert.equal(agentMarkdown('[docs]( https://evil.test )'), 'docs (https://evil.test)');
  for (const input of ['x![[a](b)](https://evil.test/i.png)', '[!](u)[y](https://evil.test/j.png)']) assert.doesNotMatch(agentMarkdown(input), /!\s*\[/, input);
});

test('deep nesting stays bounded and still leaves no tag or image', () => {
  const deep = `${'!['.repeat(3000)}x${'](https://evil.test/a.png)'.repeat(3000)}<${'<'.repeat(2000)}img src=x>`;
  const started = Date.now(), out = agentMarkdown(deep);
  assert.ok(Date.now() - started < 1000);
  assert.doesNotMatch(out, /!\s*\[/); assert.doesNotMatch(out, /<[A-Za-z]/);
  assert.equal(agentMarkdown('> [r]: https://evil.test\n![a][r]').trim(), 'a');
});

test('the cleanup after the pass cap cannot rebuild a tag or an image', () => {
  const capped = (tail) => `${'<'.repeat(9)}${'x>'.repeat(9)}${tail}`;
  for (const input of [capped('<<img src=https://evil.test/p>'), '!![x](https://evil.test/a.png)', '! ! [x](https://evil.test/b.png)',
    `${'!['.repeat(8)}x${'](u)'.repeat(8)}`, `${'<'.repeat(7)}<img src=x>${'>'.repeat(7)}`]) {
    const out = agentMarkdown(input);
    assert.doesNotMatch(out, /![\s!]*\[/, input);
    assert.doesNotMatch(out, /<[A-Za-z/!?]/, input);
  }
});
