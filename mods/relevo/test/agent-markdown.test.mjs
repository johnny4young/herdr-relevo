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
