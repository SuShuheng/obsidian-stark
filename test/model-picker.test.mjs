import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, settings, vaultApp } from './harness.mjs';

beforeEach(() => {
  for (const provider of ['anthropic', 'openai', 'chatgpt-oauth']) api.clearCatalogModels(provider);
});

async function pluginWithCatalog(models) {
  const identity = await api.catalogIdentity('chatgpt-oauth', 'picker-account');
  api.cachedCatalog({
    entries: [{ provider: 'chatgpt-oauth', identity, fetchedAt: Date.now(), models }],
  }, 'chatgpt-oauth', identity);
  const plugin = new api.ChatPlugin();
  plugin.settings = {
    ...settings('chatgpt-oauth'),
    model: models[0].value,
    thinkingLevel: '',
    language: 'en',
    modelCatalog: {
      entries: [{ provider: 'chatgpt-oauth', identity, fetchedAt: Date.now(), models }],
    },
  };
  let saves = 0;
  plugin.saveSettings = async () => { saves++; };
  plugin.chatgptOAuth = { getCredential: () => ({ accountId: 'picker-account' }) };
  return { plugin, saves: () => saves };
}

test('In-chat picker exposes only the enabled ChatGPT catalog models and thinking levels', async () => {
  const models = [
    { value: 'gpt-5.5', label: 'GPT-5.5', reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'low' },
    { value: 'gpt-4o', label: 'GPT-4o' },
  ];
  const { plugin } = await pluginWithCatalog(models);
  plugin.settings.model = 'gpt-5.5';
  plugin.settings.modelPreferences = { 'gpt-4o': { enabled: false } };
  const state = plugin.modelPickerState();
  assert.equal(state.model, 'gpt-5.5');
  assert.equal(state.thinkingLevel, '');
  assert.deepEqual(state.options.map(option => option.value), ['gpt-5.5']);
  assert.equal(state.options.find(option => option.value === 'gpt-5.5').group, 'GPT-5');
  assert.deepEqual(state.options.find(option => option.value === 'gpt-5.5').reasoningEfforts, ['low', 'medium', 'high']);
});

test('A selected model remains in the picker even if old data marked it disabled', async () => {
  const models = [
    { value: 'gpt-5.5', label: 'GPT-5.5' },
    { value: 'gpt-4o', label: 'GPT-4o' },
  ];
  const { plugin } = await pluginWithCatalog(models);
  plugin.settings.model = 'gpt-5.5';
  plugin.settings.modelPreferences = { 'gpt-5.5': { enabled: false }, 'gpt-4o': { enabled: false } };
  assert.deepEqual(plugin.modelPickerState().options.map(option => option.value), ['gpt-5.5']);
});

test('Changing model from the chat saves a supported thinking level and resets an unsupported one', async () => {
  const models = [
    { value: 'gpt-5.5', label: 'GPT-5.5', reasoningEfforts: ['low', 'medium', 'high'] },
    { value: 'gpt-4o', label: 'GPT-4o' },
  ];
  const { plugin, saves } = await pluginWithCatalog(models);
  plugin.settings.thinkingLevel = 'high';
  await plugin.selectChatModel('gpt-5.5', 'high');
  assert.equal(saves(), 0);
  await plugin.selectChatModel('gpt-4o', 'high');
  assert.equal(plugin.settings.model, 'gpt-4o');
  assert.equal(plugin.settings.thinkingLevel, '');
  assert.equal(saves(), 1);
});

test('Loading old provider data forces ChatGPT OAuth and filters old catalog entries', async () => {
  const { app } = vaultApp();
  const plugin = new api.ChatPlugin();
  plugin.app = { ...app, secretStorage: { getSecret: () => '' } };
  const openaiIdentity = await api.catalogIdentity('openai', 'old-openai');
  const oauthIdentity = await api.catalogIdentity('chatgpt-oauth', 'account');
  plugin.loadData = async () => ({
    provider: 'openai',
    model: 'gpt-6.1-sol',
    modelCatalog: {
      entries: [
        { provider: 'openai', identity: openaiIdentity, fetchedAt: 1, models: [] },
        { provider: 'chatgpt-oauth', identity: oauthIdentity, fetchedAt: 2, models: [] },
      ],
    },
  });
  await plugin.loadSettings();
  assert.equal(plugin.settings.provider, 'chatgpt-oauth');
  assert.equal(plugin.settings.model, 'gpt-5.5');
  assert.deepEqual(plugin.settings.modelCatalog.entries.map(entry => entry.provider), ['chatgpt-oauth']);
});

test('Refreshing the picker falls back to the first enabled model when the saved model disappears', async () => {
  const oldModels = [{ value: 'gpt-old', label: 'GPT Old' }];
  const { plugin, saves } = await pluginWithCatalog(oldModels);
  const identity = plugin.settings.modelCatalog.entries[0].identity;
  plugin.settings.model = 'gpt-old';
  plugin.settings.modelCatalog.entries[0].fetchedAt = 0;
  plugin.chatgptOAuth = {
    getCredential: () => ({ accessToken: 'token', accountId: 'picker-account' }),
    getUsableCredential: async () => ({ accessToken: 'token', accountId: 'picker-account' }),
  };
  globalThis.__providerRequest = async request => {
    if (request.url.includes('/codex/models')) {
      return { status: 200, json: { models: [
        { slug: 'gpt-new', display_name: 'GPT New', visibility: 'list' },
        { slug: 'gpt-disabled', display_name: 'GPT Disabled', visibility: 'list' },
      ] } };
    }
    return { status: 200, json: { tag_name: 'rust-v1.2.3' } };
  };
  const state = await plugin.refreshModelPickerState();
  assert.ok(plugin.settings.modelCatalog.entries.some(entry => entry.identity === identity));
  assert.equal(plugin.settings.model, 'gpt-new');
  assert.equal(plugin.settings.thinkingLevel, '');
  assert.equal(state.options[0].value, 'gpt-new');
  assert.equal(saves(), 1);
});
