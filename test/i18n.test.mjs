import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, settingsApp } from './harness.mjs';

test('Plugin language resolves explicit choices and translates UI strings with variables', () => {
  assert.equal(api.resolveLanguage('zh'), 'zh');
  assert.equal(api.resolveLanguage('en'), 'en');
  assert.equal(api.thinkingLevelName('zh', 'high'), '高度');
  assert.equal(api.thinkingLevelName('zh', 'custom-level'), 'custom-level');
  assert.equal(api.translate('en', 'Model'), 'Model');
  assert.equal(api.translate('zh', 'Model'), '模型');
  assert.equal(api.translate('zh', 'Default ({level})', { level: 'high' }), '默认（high）');
  assert.equal(api.translate('zh', 'Not translated'), 'Not translated');
});

test('Model header follows the effective, localized thinking level', async () => {
  const identity = await api.catalogIdentity('chatgpt-oauth', 'header-account');
  api.cachedCatalog({
    entries: [{
      provider: 'chatgpt-oauth',
      identity,
      fetchedAt: Date.now(),
      models: [{
        value: 'gpt-5.5',
        label: 'GPT-5.5',
        reasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium',
      }],
    }],
  }, 'chatgpt-oauth', identity);
  assert.equal(api.getModelHeaderLabel('chatgpt-oauth', 'gpt-5.5', 'high', 'zh'), 'GPT-5.5 · 高度');
  assert.equal(api.getModelHeaderLabel('chatgpt-oauth', 'gpt-5.5', 'unsupported', 'zh'), 'GPT-5.5 · 中度');
  api.clearCatalogModels('chatgpt-oauth');
});

test('Settings page titles follow the saved language', () => {
  const plugin = {
    settings: { ...api.DEFAULT_SETTINGS, language: 'zh' },
    chatgptOAuth: { getCredential: () => null },
  };
  const tab = new api.ChatSettingTab(settingsApp, plugin);
  assert.deepEqual(tab.getSettingDefinitions().map(page => page.name), [
    '常规', '模型', '聊天', '知识库', '代理', '语音', '数据与诊断', '关于',
  ]);
});
