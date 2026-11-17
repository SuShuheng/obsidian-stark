// The settings tab: redraws still pending when it is closed are skipped.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, settings, settingsApp } from './harness.mjs';

// A settings row whose text or dropdown control records its onChange handler.
function row() {
  const r = {};
  const control = {
    inputEl: {},
    setPlaceholder: () => control, setValue: () => control, addOption: () => control,
    onChange: handler => { r.change = handler; return control; },
  };
  r.setName = () => r;
  r.setDesc = () => r;
  r.addText = render => { render(control); return r; };
  r.addDropdown = render => { render(control); return r; };
  return r;
}

test('A closed settings tab is not redrawn by a pending refresh; shown again, it is', async () => {
  for (const newObsidian of [false, true]) {
    globalThis.__supportsNewObsidian = newObsidian;
    const plugin = { settings: { ...settings('chatgpt-oauth'), language: 'en' }, async saveSettings() {} };
    const tab = new api.ChatSettingTab(settingsApp, plugin);
    let redraws = 0;
    tab.display = tab.update = () => { redraws++; };
    const language = row();
    tab.renderLanguage(language);

    tab.hide();
    await language.change('zh');
    assert.equal(redraws, 0);

    // Shown again (Obsidian 1.13+ asks for the definitions), it redraws.
    tab.getAllSettingDefinitions();
    await language.change('en');
    assert.equal(redraws, 1);
  }
  globalThis.__supportsNewObsidian = false;
});

test('restoring a cached provider catalog updates the header without a request or save', async () => {
  for (const provider of ['anthropic', 'chatgpt-oauth']) {
    const secret = `fake-cache-header-${provider}`;
    const identity = await api.catalogIdentity(provider, secret);
    const plugin = Object.create(api.ChatPlugin.prototype);
    plugin.settings = { ...settings(provider), model: 'cache-header-model', thinkingLevel: '', apiKey: secret,
      modelCatalog: { entries: [{ provider, identity, fetchedAt: Date.now(), models: [{ value: 'cache-header-model', label: 'Cached QA model', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', thinkingType: 'adaptive' }] }] } };
    plugin.chatgptOAuth = { getCredential: () => ({ accountId: secret }) };
    let header;
    let saves = 0;
    plugin.getChatView = () => ({ updateModel: label => { header = label; } });
    plugin.saveSettings = async () => { saves++; };
    globalThis.__providerRequest = async () => { throw new Error('a fresh cache must not request models'); };
    api.clearCatalogModels(provider);
    plugin.getChatView().updateModel(plugin.modelHeaderLabel());
    assert.notEqual(header, 'Cached QA model · high');
    const tab = new api.ChatSettingTab({}, plugin);
    tab.refreshSettingsTab = () => {};
    await tab.loadCatalog(false);
    assert.equal(header, 'Cached QA model · high');
    assert.equal(saves, 0);
    api.clearCatalogModels(provider);
  }
});
