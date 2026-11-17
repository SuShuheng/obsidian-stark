import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, callbacks, call, response, settings, text, transport, vaultApp } from './harness.mjs';

test('Agent tool policy: disabled tools are hidden from the model and cannot execute', async () => {
  const tools = api.enabledToolDefinitions({
    ...settings('anthropic'),
    toolPreferences: { read_document: { enabled: false } },
  });
  assert.ok(!tools.some(tool => tool.name === 'read_document'));
  assert.ok(tools.some(tool => tool.name === 'edit_document'));

  const { app } = vaultApp();
  const pluginSettings = { ...settings('anthropic'), toolPreferences: { read_document: { enabled: false } } };
  const loop = new api.AgentLoop(app, pluginSettings);
  const requests = transport((_body, index) => index === 0
    ? response('anthropic', [call('disabled-1', 'read_document', { path: 'Untitled.md' })], 'tool_use')
    : response('anthropic', [text('done')], 'end_turn', index));
  const run = callbacks();
  await loop.run('Read the note', run);
  assert.ok(!requests[0].tools.some(tool => tool.name === 'read_document'));
  const result = requests[1].messages.at(-1).content.find(block => block.type === 'tool_result');
  assert.equal(result.is_error, true);
  assert.match(result.content, /disabled in Stark's Agent settings/);
});

test('Agent tool policy: ask approval runs after a yes and leaves no side effect after a no', async () => {
  const { app } = vaultApp();
  const pluginSettings = {
    ...settings('anthropic'),
    toolPreferences: {
      read_document: { permission: 'ask' },
      edit_document: { permission: 'ask' },
    },
  };
  const makeRun = approved => {
    const loop = new api.AgentLoop(app, pluginSettings);
    const asks = [];
    const run = callbacks({
      onAskUser: async () => '',
      onToolApproval: async (name, input) => {
        asks.push({ name, input });
        return approved;
      },
    });
    return { loop, asks, run };
  };

  const accepted = makeRun(true);
  const acceptedRequests = transport((_body, index) => index === 0
    ? response('anthropic', [call('approved-1', 'read_document', { path: 'Untitled.md' })], 'tool_use')
    : response('anthropic', [text('read')], 'end_turn', index));
  await accepted.loop.run('Read it', accepted.run);
  assert.equal(accepted.asks.length, 1);
  const acceptedResult = acceptedRequests[1].messages.at(-1).content.find(block => block.type === 'tool_result');
  assert.equal(acceptedResult.is_error, false);
  assert.match(acceptedResult.content, /Original/);

  const rejected = makeRun(false);
  const rejectedRequests = transport((_body, index) => index === 0
    ? response('anthropic', [call('rejected-1', 'edit_document', { path: 'Untitled.md', old_text: 'Original', new_text: 'Changed' })], 'tool_use')
    : response('anthropic', [text('not changed')], 'end_turn', index));
  await rejected.loop.run('Change it', rejected.run);
  assert.equal(rejected.asks.length, 1);
  const rejectedResult = rejectedRequests[1].messages.at(-1).content.find(block => block.type === 'tool_result');
  assert.equal(rejectedResult.is_error, true);
  assert.match(rejectedResult.content, /user rejected this edit_document call/);
  assert.equal(await app.vault.cachedRead(app.vault.getFileByPath('Untitled.md')), 'Original');
});
