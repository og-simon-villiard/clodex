// Run: node --test
// Covers jira-cli's pure logic: ticket-key validation and issue normalization
// (both plain-string and ADF descriptions). The CLI shell-outs (view/transition/
// comment) aren't exercised here — they need a live acli/jira + auth.
const { test } = require('node:test');
const assert = require('node:assert');
const jira = require('../jira-cli');

test('validKey: accepts ABC-123, rejects junk', () => {
  assert.ok(jira.validKey('ABC-152'));
  assert.ok(jira.validKey('ABC-1'));
  assert.ok(jira.validKey('PROJ_X-9'));
  assert.ok(!jira.validKey('nope'));
  assert.ok(!jira.validKey('123-456'));   // must start with a letter
  assert.ok(!jira.validKey('ABC'));        // needs a number
  assert.ok(!jira.validKey(''));
  assert.ok(!jira.validKey(null));
});

test('normalizeIssue: standard REST shape → flat fields', () => {
  const issue = jira.normalizeIssue({
    key: 'ABC-152',
    fields: {
      summary: 'Do the thing',
      status: { name: 'In Progress' },
      issuetype: { name: 'Story' },
      description: 'Plain text description',
    },
  });
  assert.deepStrictEqual(issue, {
    key: 'ABC-152',
    summary: 'Do the thing',
    status: 'In Progress',
    type: 'Story',
    description: 'Plain text description',
  });
});

test('normalizeIssue: ADF description is flattened to text', () => {
  const adf = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Line one.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Line two.' }] },
    ],
  };
  const issue = jira.normalizeIssue({ key: 'X-1', fields: { summary: 's', description: adf } });
  assert.match(issue.description, /Line one\./);
  assert.match(issue.description, /Line two\./);
});

test('normalizeIssue: missing fields degrade gracefully', () => {
  const issue = jira.normalizeIssue({ key: 'X-2', fields: {} });
  assert.strictEqual(issue.key, 'X-2');
  assert.strictEqual(issue.summary, '');
  assert.strictEqual(issue.status, null);
  assert.strictEqual(issue.type, null);
  assert.strictEqual(issue.description, '');
  assert.strictEqual(jira.normalizeIssue(null), null);
});

test('detect: returns acli | jira | null (whatever is on PATH)', () => {
  const d = jira.detect();
  assert.ok(d === 'acli' || d === 'jira' || d === null, `unexpected: ${d}`);
});
