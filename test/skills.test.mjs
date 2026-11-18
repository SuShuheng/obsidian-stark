// Skills: found in the skills folder, listed in the system prompt, loaded
// by use_skill or /name with their other files, offered after `/`.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, settings, transport, response, text, call, callbacks } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
});

const { skills } = api;

const TEXT = {
  'Skills/meeting-notes/SKILL.md': '---\nname: meeting-notes\ndescription: Write meeting notes from a transcript.\n---\n\nUse the template.',
  'Skills/meeting-notes/template.md': '# Meeting',
  'Skills/meeting-notes/examples/one.md': 'Example',
  'Skills/Weekly review/SKILL.md': 'Go through the week.',
};
const PROPERTIES = {
  'Skills/meeting-notes/SKILL.md': { frontmatter: { name: 'meeting-notes', description: 'Write meeting notes from a transcript.' }, frontmatterPosition: { end: { offset: TEXT['Skills/meeting-notes/SKILL.md'].indexOf('\n\nUse') } } },
};

// A vault with the files above (and an empty skill folder), as far as skills and the loop use it.
function skillsApp() {
  const files = new Map();
  const folders = new Map();
  const folder = path => {
    if (!folders.has(path)) {
      const created = new api.TFolder(path);
      folders.set(path, created);
      const parent = path.includes('/') ? folder(path.slice(0, path.lastIndexOf('/'))) : null;
      parent?.children.push(created);
    }
    return folders.get(path);
  };
  for (const path of Object.keys(TEXT)) {
    const parent = folder(path.slice(0, path.lastIndexOf('/')));
    const file = Object.assign(new api.TFile(path), { parent });
    parent.children.push(file);
    files.set(path, file);
  }
  folder('Skills/empty');
  return {
    workspace: { getActiveFile: () => null },
    vault: {
      getName: () => 'Test vault',
      getMarkdownFiles: () => [...files.values()],
      getFolderByPath: path => folders.get(path) ?? null,
      getFileByPath: path => files.get(path) ?? null,
      cachedRead: async file => TEXT[file.path],
    },
    metadataCache: { getFileCache: file => PROPERTIES[file.path] ?? null, getFirstLinkpathDest: () => null },
  };
}

// A Vault whose skills live under Obsidian's hidden `.agents` folder. The
// Vault index cannot see that folder, but the adapter can.
function hiddenSkillsApp() {
  const root = '.agents/skills';
  const skill = `${root}/source-command-su`;
  const files = new Map([
    [`${skill}/SKILL.md`, '---\nname: "source-command-su"\ndescription: "Update the resource index"\n---\n\nDo the update.'],
    [`${skill}/notes.md`, 'Resource notes'],
  ]);
  return {
    vault: {
      getFolderByPath: () => null,
      getFileByPath: () => null,
      adapter: {
        async list(path) {
          if (path === root) return { files: [], folders: [skill] };
          if (path === skill) return { files: [...files.keys()], folders: [] };
          return { files: [], folders: [] };
        },
        async exists(path) { return files.has(path); },
        async read(path) {
          if (!files.has(path)) throw new Error('ENOENT');
          return files.get(path);
        },
      },
    },
    metadataCache: { getFileCache: () => null },
  };
}

// Mobile: hidden `.agents/skills` is not exposed, but a visible mirror is.
function mirroredSkillsApp() {
  const root = 'Stark Skills';
  const folder = new api.TFolder(root);
  const skillFolder = new api.TFolder(`${root}/mobile-skill`);
  const text = '---\nname: mobile-skill\ndescription: Use the visible mobile mirror.\n---\n\nDo the mobile task.';
  const file = Object.assign(new api.TFile(`${skillFolder.path}/SKILL.md`), { parent: skillFolder });
  const notes = Object.assign(new api.TFile(`${skillFolder.path}/notes.md`), { parent: skillFolder });
  folder.children.push(skillFolder);
  skillFolder.children.push(file, notes);
  const files = new Map([[file.path, file], [notes.path, notes]]);
  const texts = new Map([[file.path, text], [notes.path, 'Mobile notes']]);
  return {
    vault: {
      getFolderByPath: path => path === root ? folder : path === skillFolder.path ? skillFolder : null,
      getFileByPath: path => files.get(path) ?? null,
      cachedRead: async found => texts.get(found.path) ?? '',
    },
    metadataCache: {
      getFileCache: found => found.path === file.path
        ? { frontmatter: { name: 'mobile-skill', description: 'Use the visible mobile mirror.' }, frontmatterPosition: { end: { offset: text.indexOf('\n\nDo') } } }
        : null,
    },
  };
}

// A hidden source that can be mirrored into a visible mobile folder.
function mirrorSourceApp() {
  const root = '.agents/skills';
  const skill = `${root}/source-command-su`;
  const examples = `${skill}/examples`;
  const files = new Map([
    [`${skill}/SKILL.md`, '---\nname: source-command-su\ndescription: Update the resource index\n---\n\nDo the update.'],
    [`${skill}/notes.md`, 'Resource notes'],
    [`${examples}/one.md`, 'Example'],
  ]);
  const folders = new Set([root, skill, examples]);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const adapter = {
    async list(path) {
      if (path === root) return { files: [], folders: [skill] };
      if (path === skill) return { files: [`${skill}/SKILL.md`, `${skill}/notes.md`], folders: [examples] };
      if (path === examples) return { files: [`${examples}/one.md`], folders: [] };
      return { files: [], folders: [] };
    },
    async exists(path) { return files.has(path) || folders.has(path); },
    async read(path) { return files.get(path); },
    async readBinary(path) { return encoder.encode(files.get(path)).buffer; },
    async writeBinary(path, data) {
      files.set(path, decoder.decode(new Uint8Array(data)));
      const parent = path.slice(0, path.lastIndexOf('/'));
      if (parent) folders.add(parent);
    },
    async mkdir(path) { folders.add(path); },
  };
  return {
    app: {
      vault: {
        getFolderByPath: () => null,
        getFileByPath: () => null,
        adapter,
      },
      metadataCache: { getFileCache: () => null },
    },
    files,
  };
}

const systemText = body => typeof body.system === 'string' ? body.system : body.system.map(block => block.text).join('');
const resultText = block => typeof block.content === 'string' ? block.content : block.content.map(c => c.text ?? '').join('');

test('skills: each subfolder with a SKILL.md; the name from its properties, else the folder', () => {
  const found = skills.findSkills(skillsApp(), 'Skills');
  assert.deepEqual(found, [
    { name: 'meeting-notes', description: 'Write meeting notes from a transcript.', path: 'Skills/meeting-notes/SKILL.md' },
    { name: 'Weekly review', description: '', path: 'Skills/Weekly review/SKILL.md' },
  ]);
  assert.deepEqual(skills.findSkills(skillsApp(), 'Elsewhere'), []);
});

test('skills: the system prompt lists them after the built-in prompt and before AGENTS.md; none without skills', () => {
  const list = skills.skillsPrompt(skills.findSkills(skillsApp(), 'Skills'));
  assert.match(list, /call use_skill with its name/);
  assert.match(list, /- meeting-notes: Write meeting notes from a transcript\.\n- Weekly review: \(no description\)/);
  assert.equal(skills.skillsPrompt([]), null);
  const prompt = api.buildSystemPrompt('Be brief.', list);
  assert.ok(prompt.indexOf('## Skills') < prompt.indexOf('## This vault\'s instructions'));
  assert.doesNotMatch(api.buildSystemPrompt(null, null), /## Skills/);
});

test('A turn: the skills of the folder in the settings are in the system prompt and the transcript; use_skill loads from it', async () => {
  const app = skillsApp();
  const loop = new api.AgentLoop(app, { ...settings('anthropic'), skillsFolder: 'Skills' });
  const requests = transport((body, index) => index === 0
    ? response('anthropic', [call('s1', 'use_skill', { name: 'meeting-notes' })], 'tool_use')
    : response('anthropic', [text('done')], 'end_turn', index));
  const run = callbacks();
  await loop.run('Notes from this transcript, please', run);
  assert.match(systemText(requests[0]), /## Skills\n[\s\S]*- meeting-notes: Write meeting notes/);
  assert.match(loop.exportTranscript(), /- meeting-notes: Write meeting notes/);
  assert.deepEqual(run.executed, ['use_skill']);
  const result = requests[1].messages.at(-1).content.find(b => b.type === 'tool_result');
  assert.match(resultText(result), /^<skill name="meeting-notes"/);

  // Another folder in the settings: no skills, no Skills section.
  const elsewhere = new api.AgentLoop(app, { ...settings('anthropic'), skillsFolder: 'Elsewhere' });
  const more = transport(() => response('anthropic', [text('ok')]));
  await elsewhere.run('Hi', callbacks());
  assert.doesNotMatch(systemText(more[0]), /## Skills/);
});

test('use_skill: the instructions without properties and the skill\'s other files; an unknown name lists the skills', async () => {
  const loaded = await api.executeTool(skillsApp(), 'use_skill', { name: '/Meeting-Notes' }, async () => '',
    undefined, undefined, 'Skills');
  assert.equal(loaded.isError, false);
  assert.match(loaded.result, /^<skill name="meeting-notes" path="Skills\/meeting-notes\/SKILL\.md">\nUse the template\.\n<\/skill>/);
  assert.match(loaded.result, /other files.*:\n- Skills\/meeting-notes\/examples\/one\.md\n- Skills\/meeting-notes\/template\.md$/);
  assert.doesNotMatch(loaded.result, /description:/);
  const plain = await skills.useSkill(skillsApp(), 'Skills', { name: 'weekly review' });
  assert.equal(plain.result, '<skill name="Weekly review" path="Skills/Weekly review/SKILL.md">\nGo through the week.\n</skill>');
  const missing = await skills.useSkill(skillsApp(), 'Skills', { name: 'nope' });
  assert.deepEqual(missing, { result: 'No skill named "nope". Skills: meeting-notes, Weekly review.', isError: true });
  assert.equal(api.toolLabels.toolLabel('use_skill', { name: '/meeting-notes' }), 'Used the skill meeting-notes');
});

test('Skills: the shared .agents/skills default; allSkills keeps disabled skills, findSkills removes them', () => {
  assert.equal(skills.DEFAULT_SKILLS_FOLDER, '.agents/skills');
  const app = skillsApp();
  const all = skills.allSkills(app, 'Skills');
  assert.equal(all.length, 2);
  assert.deepEqual(skills.findSkills(app, 'Skills', {
    'Skills/Weekly review/SKILL.md': { enabled: false },
  }).map(skill => skill.name), ['meeting-notes']);
});

test('Hidden .agents/skills is scanned through the Vault adapter and loaded by use_skill', async () => {
  const app = hiddenSkillsApp();
  const found = await skills.refreshSkills(app, '.agents/skills');
  assert.deepEqual(found, [{
    name: 'source-command-su',
    description: 'Update the resource index',
    path: '.agents/skills/source-command-su/SKILL.md',
  }]);
  assert.deepEqual(skills.allSkills(app, '.agents/skills'), found);
  const loaded = await skills.useSkill(app, '.agents/skills', { name: 'source-command-su' });
  assert.equal(loaded.isError, false);
  assert.match(loaded.result, /^<skill name="source-command-su"/);
  assert.match(loaded.result, /Do the update\./);
  assert.match(loaded.result, /notes\.md/);
});

test('Mobile: hidden .agents/skills falls back to the visible Stark Skills mirror', async () => {
  const app = mirroredSkillsApp();
  assert.equal(skills.MOBILE_SKILLS_FOLDER, 'Stark Skills');
  assert.deepEqual(skills.allSkills(app, '.agents/skills').map(skill => skill.path), [
    'Stark Skills/mobile-skill/SKILL.md',
  ]);
  const found = await skills.refreshSkills(app, '.agents/skills');
  assert.deepEqual(found, [{
    name: 'mobile-skill',
    description: 'Use the visible mobile mirror.',
    path: 'Stark Skills/mobile-skill/SKILL.md',
  }]);
  const loaded = await skills.useSkill(app, '.agents/skills', { name: 'mobile-skill' });
  assert.equal(loaded.isError, false);
  assert.match(loaded.result, /Do the mobile task\./);
  assert.match(loaded.result, /Stark Skills\/mobile-skill\/notes\.md/);
});

test('Desktop can mirror hidden .agents/skills into the visible mobile folder', async () => {
  const { app, files } = mirrorSourceApp();
  assert.equal(await skills.mirrorSkillsForMobile(app, '.agents/skills'), 1);
  assert.equal(files.get('Stark Skills/source-command-su/SKILL.md'),
    '---\nname: source-command-su\ndescription: Update the resource index\n---\n\nDo the update.');
  assert.equal(files.get('Stark Skills/source-command-su/notes.md'), 'Resource notes');
  assert.equal(files.get('Stark Skills/source-command-su/examples/one.md'), 'Example');
});

test('Desktop scans automatically copy hidden skills into the mobile-visible folder', async () => {
  const previous = globalThis.__isDesktopApp;
  globalThis.__isDesktopApp = true;
  try {
    const { app, files } = mirrorSourceApp();
    const found = await skills.refreshSkills(app, '.agents/skills');
    assert.equal(found[0].name, 'source-command-su');
    assert.equal(files.get('Stark Skills/source-command-su/SKILL.md'),
      '---\nname: source-command-su\ndescription: Update the resource index\n---\n\nDo the update.');
  } finally {
    globalThis.__isDesktopApp = previous;
  }
});

test('/name: invoked at the start or after a space, loaded along with the message', async () => {
  const found = skills.findSkills(skillsApp(), 'Skills');
  assert.deepEqual(skills.invokedSkills('/meeting-notes for today, see a/b and /nope', found).map(s => s.name), ['meeting-notes']);
  assert.deepEqual(skills.invokedSkills('and/meeting-notes', found), []);
  // A name with a space (the folder's), any case, punctuation after it; in the order named.
  assert.deepEqual(skills.invokedSkills('Do /weekly review. Then /Meeting-Notes!', found).map(s => s.name), ['Weekly review', 'meeting-notes']);
  assert.deepEqual(skills.invokedSkills('/meeting-notes-long and /meeting-notes2', found), []);
  const loaded = await skills.invokedSkillsText(skillsApp(), 'Skills', 'Please /meeting-notes');
  assert.match(loaded, /^\[Skills the user invoked with \/name; follow them for this request:\]\n<skill name="meeting-notes"/);
  assert.equal(await skills.invokedSkillsText(skillsApp(), 'Skills', 'no skill here'), null);
});

test('Loaded skills report their file scope for both use_skill and slash context', async () => {
  const app = skillsApp();
  const original = app.vault.getFileByPath;
  app.vault.getFileByPath = path => path === 'Skills/AGENTS.md' || path === 'Skills/meeting-notes/AGENTS.md' ? { path } : original(path);
  const read = app.vault.cachedRead;
  app.vault.cachedRead = async file => file.path === 'Skills/AGENTS.md' ? 'Keep skill results concise.' : file.path === 'Skills/meeting-notes/AGENTS.md' ? 'Meeting notes require actions.' : read(file);
  const loop = new api.AgentLoop(app, { ...settings('anthropic'), skillsFolder: 'Skills' });
  const requests = transport((body, index) => index === 0
    ? response('anthropic', [call('use', 'use_skill', { name: 'meeting-notes' })], 'tool_use')
    : response('anthropic', [text('Done')], 'end_turn', index));
  await loop.run('Use the skill', callbacks());
  const result = requests[1].messages.at(-1).content.find(block => block.type === 'tool_result');
  assert.match(resultText(result), /Keep skill results concise[\s\S]*Meeting notes require actions/);
  const context = await skills.invokedSkillsContext(app, 'Skills', '/meeting-notes');
  assert.deepEqual(context.instructionPaths, ['Skills/meeting-notes/SKILL.md', 'Skills/meeting-notes/examples/one.md', 'Skills/meeting-notes/template.md']);
  const fresh = new api.AgentLoop(app, { ...settings('anthropic'), skillsFolder: 'Skills' });
  const initial = transport(() => response('anthropic', [text('ok')]));
  await fresh.run('/meeting-notes', callbacks(), null, [], 'slash', context);
  assert.match(initial[0].messages.at(-1).content, /Keep skill results concise[\s\S]*Meeting notes require actions[\s\S]*<skill/);
});

test('/ autocomplete: what is being typed after a slash, and the matching skills', () => {
  assert.deepEqual(skills.skillAt('/mee', 4), { start: 0, query: 'mee' });
  assert.deepEqual(skills.skillAt('hi /', 4), { start: 3, query: '' });
  assert.equal(skills.skillAt('a/b', 3), null);
  assert.equal(skills.skillAt('/done now', 9), null);
  const found = skills.findSkills(skillsApp(), 'Skills');
  assert.deepEqual(skills.skillCandidates(found, '').map(s => s.name), ['meeting-notes', 'Weekly review']);
  assert.deepEqual(skills.skillCandidates(found, 'wr').map(s => s.name), ['Weekly review']);
});

test('Sending /name from the chat: the skill goes to the model before the message; the chat shows the text only', async () => {
  const app = skillsApp();
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.settings = { ...settings('anthropic'), skillsFolder: 'Skills' };
  plugin.agent = new api.AgentLoop(app, plugin.settings);
  plugin.chatHistory = [];
  plugin.saveChatHistory = async () => {};
  const view = new api.ObsidianChatView({}, plugin);
  const shown = [];
  view.chatContainer = {
    addUserMessage(value) { shown.push(value); }, addAssistantMessage() { return 0; }, updateAssistantMessage() {}, removeMessage() {},
    addToolCall() { return 0; }, updateToolResult() {}, addError(value) { shown.push(value); }, showThinking() {}, hideThinking() {},
    setInputEnabled() {}, setBusy() {}, foldTurn() {}, updateConversations() {}, setContinue() {}, setQueued() {}, focus() {}, cancelAskUser() {}, setTitle() {},
  };
  const requests = transport(() => response('anthropic', [text('ok')]));
  await view.handleUserMessage('/meeting-notes for the call', null);
  const sent = requests[0].messages.at(-1).content;
  assert.match(sent, /\[Skills the user invoked with \/name[\s\S]*Use the template\.\n<\/skill>[\s\S]*\n\n\/meeting-notes for the call$/);
  assert.deepEqual(shown, ['/meeting-notes for the call']);
  assert.equal(plugin.chatHistory[0].text, '/meeting-notes for the call');
});

// A settings row that records its controls.
function row() {
  const r = { buttons: [], toggles: [], extras: [], setName(name) { r.name = name; return r; }, setDesc(desc) { r.desc = desc; return r; } };
  r.addText = fn => {
    const t = {
      inputEl: { addEventListener(type, f) { r[type] = f; } },
      setPlaceholder() { return t; },
      setValue(v) { r.value = v; return t; },
      getValue() { return r.value; },
      onChange(f) { r.change = f; return t; },
    };
    fn(t);
    return r;
  };
  r.addToggle = fn => {
    const t = { setValue(v) { t.value = v; return t; }, setTooltip(v) { t.tooltip = v; return t; }, onChange(f) { t.change = f; return t; } };
    r.toggles.push(t);
    fn(t);
    return r;
  };
  r.addButton = fn => {
    const b = { setButtonText(t) { b.text = t; return b; }, setIcon() { return b; }, setTooltip() { return b; }, onClick(f) { b.click = f; return b; } };
    r.buttons.push(b);
    fn(b);
    return r;
  };
  r.addExtraButton = fn => {
    const b = {
      setIcon() { return b; },
      setTooltip(t) { b.tooltip = t; return b; },
      setDisabled(value) { b.disabled = value; return b; },
      onClick(f) { b.click = f; return b; },
    };
    r.extras.push(b);
    fn(b);
    return r;
  };
  return r;
}

// The skills vault, where New skill can create folders and files and open them.
function settingsTab(skillsFolder) {
  const app = skillsApp();
  const made = new Map();
  const opened = [];
  Object.assign(app.vault, {
    getAbstractFileByPath: path => made.get(path) ?? app.vault.getFolderByPath(path) ?? app.vault.getFileByPath(path),
    createFolder: async path => { made.set(path, { path }); },
    create: async (path, content) => { assert.ok(!made.has(path)); made.set(path, { path, content }); return { path }; },
  });
  app.workspace.getLeaf = () => ({ openFile: async file => { opened.push(file.path); } });
  const plugin = { settings: { ...settings('anthropic'), skillsFolder }, saves: 0, async saveSettings() { plugin.saves++; } };
  const tab = new api.ChatSettingTab(app, plugin);
  const redraws = { count: 0 };
  tab.update = tab.display = () => { redraws.count++; };
  return { plugin, tab, made, opened, redraws };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('Settings (Obsidian 1.13+): the skills folder, a list of its skills each opening its SKILL.md, and New skill', async () => {
  const { plugin, tab, made, opened, redraws } = settingsTab('Skills');
  const definitions = tab.getAllSettingDefinitions();

  const folder = row();
  definitions.find(d => d.name === 'Skills folder').render(folder);
  assert.equal(folder.name, 'Skills folder');
  assert.equal(folder.value, 'Skills');
  await folder.change(' Work/Skills ');
  assert.equal(plugin.settings.skillsFolder, 'Work/Skills');
  assert.equal(plugin.saves, 1);
  await folder.change('Skills');
  assert.equal(plugin.settings.skillsFolder, 'Skills');
  assert.equal(plugin.saves, 2);
  folder.blur();
  assert.equal(redraws.count, 1);

  const mirror = row();
  definitions.find(d => d.name === 'Mobile Skills mirror').render(mirror);
  assert.match(mirror.desc, /Stark Skills/);
  assert.equal(mirror.buttons[0].text, 'Sync for mobile');

  const notes = row();
  definitions.find(d => d.name === '/meeting-notes').render(notes);
  assert.equal(notes.desc, 'Write meeting notes from a transcript.');
  const weekly = row();
  definitions.find(d => d.name === '/Weekly review').render(weekly);
  assert.match(weekly.desc, /No description: the AI can't tell when to use it/);
  assert.equal(weekly.toggles[0].value, true);
  await weekly.toggles[0].change(false);
  assert.deepEqual(plugin.settings.skillPreferences['Skills/Weekly review/SKILL.md'], { enabled: false });
  assert.equal(plugin.saves, 3);
  weekly.extras[0].click();
  assert.deepEqual(opened, ['Skills/Weekly review/SKILL.md']);

  // New skill: a folder with a SKILL.md from the template, opened; the next one is numbered.
  const newSkill = row();
  definitions.find(d => d.name === 'New skill').render(newSkill);
  newSkill.buttons[0].click();
  await settle();
  newSkill.buttons[0].click();
  await settle();
  assert.deepEqual([...made.keys()], ['Skills/new-skill', 'Skills/new-skill/SKILL.md', 'Skills/new-skill-2', 'Skills/new-skill-2/SKILL.md']);
  assert.match(made.get('Skills/new-skill/SKILL.md').content, /^---\nname: new-skill\ndescription: [^\n]+\n---\n/);
  assert.deepEqual(opened.slice(1), ['Skills/new-skill/SKILL.md', 'Skills/new-skill-2/SKILL.md']);
  assert.equal(redraws.count, 3);

  // A folder that isn't there yet: the list says so, New skill creates it.
  const empty = settingsTab('Elsewhere');
  const emptyDefinitions = empty.tab.getAllSettingDefinitions();
  assert.deepEqual(emptyDefinitions.filter(d => typeof d.name === 'string' && d.name.startsWith('/')), []);
  const emptyNew = row();
  emptyDefinitions.find(d => d.name === 'New skill').render(emptyNew);
  assert.equal(emptyNew.desc, 'No skills in Elsewhere/ yet.');
  emptyNew.buttons[0].click();
  await settle();
  assert.deepEqual([...empty.made.keys()], ['Elsewhere', 'Elsewhere/new-skill', 'Elsewhere/new-skill/SKILL.md']);
});

test('Settings: the skills folder can be reset to the shared default', async () => {
  const { plugin, tab, redraws } = settingsTab('Skills');
  const folder = row();
  tab.getAllSettingDefinitions().find(d => d.name === 'Skills folder').render(folder);
  const useDefault = folder.buttons.find(button => button.text === 'Use default');
  await useDefault.click();
  assert.equal(plugin.settings.skillsFolder, '.agents/skills');
  assert.equal(plugin.saves, 1);
  assert.equal(redraws.count, 1);
});


for (const via of ['tool', 'slash']) {
  test(`Nested skill resource rules accompany listed paths via ${via}`, async () => {
    const app = skillsApp();
    const original = app.vault.getFileByPath;
    const rule = 'Skills/meeting-notes/examples/AGENTS.md';
    app.vault.getFileByPath = path => path === rule ? { path } : original(path);
    const read = app.vault.cachedRead;
    app.vault.cachedRead = async file => file.path === rule ? 'NESTED-RESOURCE-RULE' : read(file);
    const loop = new api.AgentLoop(app, { ...settings('anthropic'), skillsFolder: 'Skills' });
    const context = via === 'slash' ? await skills.invokedSkillsContext(app, 'Skills', '/meeting-notes') : null;
    const requests = transport((_body, index) => via === 'tool' && index === 0
      ? response('anthropic', [call('skill', 'use_skill', { name: 'meeting-notes' })], 'tool_use')
      : response('anthropic', [text('done')], 'end_turn', index));
    const cb = callbacks();
    await loop.run(via === 'slash' ? '/meeting-notes' : 'Use the skill', cb, null, [], 'nested', context);
    assert.deepEqual(cb.errors, []);
    assert.match(JSON.stringify(requests.at(-1)), /NESTED-RESOURCE-RULE/);
    assert.match(JSON.stringify(requests.at(-1)), /examples\/one.md/);
    assert.doesNotMatch(JSON.stringify(requests), /instructionPaths/);
  });
}
