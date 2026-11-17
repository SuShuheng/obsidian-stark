// ChatGPT Responses: show only the provider's readable reasoning summary,
// never raw reasoning text, while preserving normal answer deltas.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, settings, sse, transport } from './harness.mjs';

beforeEach(() => {
  api.resetStreamTransport();
  api.setChatGPTOAuthService({
    getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }),
  });
});

test('ChatGPT Responses: reasoning summary streams separately from the answer', async () => {
  const answer = 'I checked the vault.';
  const events = [
    {
      type: 'response.reasoning_summary_part.added',
      item_id: 'reasoning-1',
      output_index: 0,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'I will inspect ' },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'the vault.' },
    { type: 'response.reasoning_text.delta', output_index: 0, delta: 'private raw reasoning' },
    { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'I will inspect the vault.' },
    { type: 'response.output_text.delta', output_index: 1, delta: answer },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: answer, annotations: [] }],
      },
    },
    { type: 'response.completed', response: { id: 'resp-summary', status: 'completed', output: [] } },
  ];
  const requests = transport(() => sse(events));
  const summaries = [];
  const deltas = [];
  let diagnostics;

  const result = await api.sendMessage(
    settings('chatgpt-oauth'),
    [{ role: 'user', content: 'Check the vault' }],
    [],
    'System',
    () => false,
    {
      onReasoningSummaryDelta: (text) => summaries.push(text),
      onTextDelta: (text) => deltas.push(text),
      onStreamDiagnostics: (value) => { diagnostics = value; },
    },
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(summaries, ['I will inspect ', 'the vault.']);
  assert.deepEqual(deltas, [answer]);
  assert.equal(result.content.find((block) => block.type === 'text')?.text, answer);
  assert.equal(diagnostics.transport, 'requestUrl');
  assert.equal(diagnostics.buffered, true);
  assert.equal(diagnostics.textDeltaCount, 1);
  assert.equal(diagnostics.reasoningSummaryDeltaCount, 2);
  assert.ok(diagnostics.eventCount >= 8);
  assert.ok(!('fallbackReason' in diagnostics) || !JSON.stringify(diagnostics).includes('private raw reasoning'));
});

test('ChatGPT Responses: a completed reasoning item supplies the summary when no deltas arrive', async () => {
  const answer = 'Finished.';
  const events = [
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'reasoning-1',
        summary: [{ type: 'summary_text', text: 'Checked the notes first.' }],
        encrypted_content: 'encrypted',
      },
    },
    { type: 'response.output_text.delta', output_index: 1, delta: answer },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: answer, annotations: [] }],
      },
    },
    { type: 'response.completed', response: { id: 'resp-summary-done', status: 'completed', output: [] } },
  ];
  transport(() => sse(events));
  const summaries = [];

  const result = await api.sendMessage(
    settings('chatgpt-oauth'),
    [{ role: 'user', content: 'Check' }],
    [],
    'System',
    () => false,
    { onReasoningSummaryDelta: (text) => summaries.push(text) },
  );

  assert.deepEqual(summaries, ['Checked the notes first.']);
  assert.equal(result.content.find((block) => block.type === 'text')?.text, answer);
});
