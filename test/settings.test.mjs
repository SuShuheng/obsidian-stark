import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { api, settings, settingsApp } from './harness.mjs';

// A settings row as Obsidian hands it to a definition's render(); records the
// controls without needing a DOM.
function row() {
  const r = {
    controls: [], dropdowns: [], toggles: [], texts: [], buttons: [], extras: [],
    settingEl: { parentElement: {} },
  };
  const record = (list, control) => {
    r.controls.push(control);
    list.push(control);
    return control;
  };
  r.setName = name => { r.name = name; return r; };
  r.setDesc = desc => { r.desc = desc; return r; };
  r.addDropdown = fn => {
    const c = record(r.dropdowns, {
      options: [],
      addOption(value, label) { c.options.push([value, label]); return c; },
      setValue(value) { c.value = value; return c; },
      setDisabled(value) { c.disabled = value; return c; },
      onChange(change) { c.change = change; return c; },
    });
    fn(c);
    return r;
  };
  r.addToggle = fn => {
    const c = record(r.toggles, {
      setValue(value) { c.value = value; return c; },
      setTooltip(value) { c.tooltip = value; return c; },
      setDisabled(value) { c.disabled = value; return c; },
      onChange(change) { c.change = change; return c; },
    });
    fn(c);
    return r;
  };
  r.addText = fn => {
    let value = '';
    const c = record(r.texts, {
      listeners: {},
      inputEl: {
        addClass() {},
        addEventListener(type, listener) { c.listeners[type] = listener; },
      },
      setPlaceholder(next) { c.placeholder = next; return c; },
      setValue(next) { value = String(next); return c; },
      getValue() { return value; },
      async change(next) {
        value = String(next);
        await c.listeners.change?.({});
      },
      async enter() {
        await c.listeners.keydown?.({ key: 'Enter', isComposing: false, preventDefault() {} });
      },
    });
    fn(c);
    return r;
  };
  r.addButton = fn => {
    const c = record(r.buttons, {
      setButtonText(value) { c.text = value; return c; },
      setIcon(value) { c.icon = value; return c; },
      setTooltip(value) { c.tooltip = value; return c; },
      setCta() { return c; },
      setDisabled(value) { c.disabled = value; return c; },
      onClick(click) { c.click = click; return c; },
    });
    fn(c);
    return r;
  };
  r.addExtraButton = fn => {
    const c = record(r.extras, {
      setIcon(value) { c.icon = value; return c; },
      setTooltip(value) { c.tooltip = value; return c; },
      setDisabled(value) { c.disabled = value; return c; },
      onClick(click) { c.click = click; return c; },
    });
    fn(c);
    return r;
  };
  return r;
}

let previousWindow;
beforeEach(() => {
  previousWindow = globalThis.window;
  globalThis.window = { setTimeout(fn) { fn(); }, clearTimeout() {} };
  globalThis.__providerRequest = async () => assert.fail('No catalog request without a key');
  globalThis.__notices = [];
});
afterEach(() => { globalThis.window = previousWindow; });

function settingsTab(provider = 'chatgpt-oauth') {
  const plugin = {
    settings: {
      ...settings(provider),
      apiKey: '',
      language: 'en',
      modelPreferences: {},
    },
    manifest: { version: '0.1.0', author: 'GuoFan Zhang' },
    saves: 0,
    async saveSettings() { plugin.saves++; },
    reloadApiKeyForProvider() {},
    chatgptOAuth: { getCredential: () => null },
  };
  const tab = new api.ChatSettingTab(settingsApp, plugin);
  let refreshes = 0;
  tab.display = tab.update = () => { refreshes++; };
  const definitions = models => {
    if (models) tab.catalogModels = models;
    return tab.getAllSettingDefinitions();
  };
  const definition = (name, models) => definitions(models).find(d => d.name === name);
  const render = (name, models) => {
    const found = definition(name, models);
    assert.ok(found, `missing setting: ${name}`);
    const setting = row();
    found.render(setting);
    return setting;
  };
  return { plugin, tab, definitions, definition, render, refreshes: () => refreshes };
}

test('Settings expose the eight focused pages and only the ChatGPT account path', () => {
  const { tab } = settingsTab();
  const pages = tab.getSettingDefinitions();
  assert.deepEqual(pages.map(page => page.name), [
    'General', 'Models', 'Chat', 'Knowledge', 'Agent', 'Voice', 'Data & diagnostics', 'About',
  ]);
  const names = tab.getAllSettingDefinitions().map(item => item.name);
  assert.ok(names.includes('ChatGPT account'));
  assert.ok(names.includes('Default chat location'));
  assert.ok(!names.includes('Provider'));
  assert.ok(!names.includes('API key'));
  assert.ok(!names.includes('MCP servers'));
  assert.ok(!names.includes('Custom model ID'));
  const chat = pages.find(page => page.name === 'Chat');
  assert.ok(chat.items.some(item => item.name === 'Compaction point'));
  assert.ok(!chat.items.some(item => item.name === 'Saved chats'));
});

test('Default chat location switches between the right sidebar and a main editor tab', async () => {
  const { plugin, render } = settingsTab();
  const location = render('Default chat location');
  const dropdown = location.dropdowns[0];
  assert.deepEqual(dropdown.options, [['sidebar', 'Right sidebar'], ['tab', 'Main editor tab']]);
  assert.equal(dropdown.value, 'sidebar');
  await dropdown.change('tab');
  assert.equal(plugin.settings.chatOpenLocation, 'tab');
  assert.equal(plugin.saves, 1);
  await dropdown.change('sidebar');
  assert.equal(plugin.settings.chatOpenLocation, 'sidebar');
  assert.equal(plugin.saves, 2);
});

test('Models page lists only the API catalog, with current-model protection and context restore', async () => {
  const models = [
    { value: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 128_000, reasoningEfforts: ['low', 'medium', 'high'] },
    { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', contextWindow: 1_000_000 },
  ];
  const { plugin, render, refreshes } = settingsTab();
  plugin.settings.model = 'gpt-5.5';

  const current = render('GPT-5.5', models);
  assert.match(current.desc, /Context: 128K/);
  assert.equal(current.toggles[0].value, true);
  assert.equal(current.toggles[0].disabled, true);
  assert.match(current.toggles[0].tooltip, /Switch to another model/);

  const other = render('GPT-6.1-Sol', models);
  assert.match(other.desc, /Context: 1M/);
  assert.equal(other.toggles[0].disabled, false);
  await other.toggles[0].change(false);
  assert.deepEqual(plugin.settings.modelPreferences['gpt-6.1-sol'], { enabled: false });
  assert.equal(plugin.saves, 1);
  await other.toggles[0].change(true);
  assert.equal(plugin.settings.modelPreferences['gpt-6.1-sol'], undefined);
  assert.equal(plugin.saves, 2);

  // The context field accepts K/M and stores a number; the restore button
  // returns to the API value and removes the override.
  const context = other.texts[0];
  assert.equal(context.placeholder, '1M');
  await context.change('2M');
  assert.equal(plugin.settings.modelPreferences['gpt-6.1-sol'].contextWindow, 2_000_000);
  assert.equal(plugin.saves, 3);
  const restore = render('GPT-6.1-Sol', models).extras[0];
  assert.equal(restore.disabled, false);
  await restore.click();
  assert.equal(plugin.settings.modelPreferences['gpt-6.1-sol'], undefined);
  assert.equal(plugin.saves, 4);
  assert.equal(refreshes(), 4);
});

test('Context window input rejects values below 1K and keeps the saved API default', async () => {
  const models = [{ value: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 128_000 }];
  const { plugin, render } = settingsTab();
  plugin.settings.model = 'gpt-5.5';
  const setting = render('GPT-5.5', models);
  await setting.texts[0].change('999');
  assert.equal(plugin.settings.modelPreferences['gpt-5.5'], undefined);
  assert.equal(plugin.saves, 0);
  assert.ok(globalThis.__notices.some(message => /at least 1K/.test(message)));
});

test('Settings load: the iteration limit from data.json stays within 1 to 100; below 1 is the default', async () => {
  for (const [saved, loaded] of [[1000, 100], [100, 100], [1, 1], [0, 20], [0.5, 20], [-5, 20], [7.6, 7], [Infinity, 20], [NaN, 20], ['50', 20], [42, 42]]) {
    const plugin = new api.ChatPlugin();
    plugin.app = { secretStorage: { getSecret: () => '' } };
    plugin.loadData = async () => ({ maxIterations: saved });
    await plugin.loadSettings();
    assert.equal(plugin.settings.maxIterations, loaded, String(saved));
  }
});

test('Settings load: old providers migrate to the ChatGPT account default', async () => {
  for (const [provider, model] of [[undefined, 'gpt-5.5'], ['anthropic', 'gpt-5.5'], ['openai', 'gpt-5.5'], ['chatgpt-oauth', 'gpt-5.5']]) {
    const plugin = new api.ChatPlugin();
    plugin.app = { secretStorage: { getSecret: () => '' } };
    plugin.loadData = async () => (provider ? { provider, model: '' } : null);
    await plugin.loadSettings();
    assert.equal(plugin.settings.provider, 'chatgpt-oauth');
    assert.equal(plugin.settings.model, model, String(provider));
  }
});

test('Old compactTokens migrate to a percentage of the known model window, or 80% without one', async () => {
  const withWindow = new api.ChatPlugin();
  withWindow.app = { secretStorage: { getSecret: () => '' } };
  withWindow.loadData = async () => ({
    provider: 'chatgpt-oauth',
    model: 'gpt-5.5',
    compactTokens: 64_000,
    modelCatalog: { entries: [{
      provider: 'chatgpt-oauth', identity: 'a'.repeat(64), fetchedAt: 1,
      models: [{ value: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 128_000 }],
    }] },
  });
  await withWindow.loadSettings();
  assert.equal(withWindow.settings.compactPercent, 50);

  const withoutWindow = new api.ChatPlugin();
  withoutWindow.app = { secretStorage: { getSecret: () => '' } };
  withoutWindow.loadData = async () => ({ compactTokens: 64_000 });
  await withoutWindow.loadSettings();
  assert.equal(withoutWindow.settings.compactPercent, 80);
});
