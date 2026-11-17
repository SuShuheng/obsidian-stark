// The live activity line and the completed work summary shown around tool calls.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from './harness.mjs';

const { activityKind, activityDetail, liveActivityLabel, completedActivityLabel } = api.activitySummary;
const entry = (name, state = 'done', input = {}) => ({ name, state, input });

test('Tool names map to stable activity categories', () => {
  assert.equal(activityKind('read_document'), 'read');
  assert.equal(activityKind('search_vault'), 'search');
  assert.equal(activityKind('edit_document'), 'edit');
  assert.equal(activityKind('create_file'), 'create');
  assert.equal(activityKind('terminal_exec'), 'command');
  assert.equal(activityKind('unknown_tool'), 'tool');
});

test('The live line shows the current action and its useful parameter', () => {
  assert.equal(
    liveActivityLabel([entry('search_vault', 'running', { query: '**/README*' })], 'zh'),
    '正在搜索代码 · **/README*',
  );
  assert.equal(
    liveActivityLabel([entry('read_document', 'running', { path: '欢迎.md' })], 'zh'),
    '正在读取 · 欢迎.md',
  );
  assert.equal(
    liveActivityLabel([entry('terminal_exec', 'running', { command: 'git status' })], 'en'),
    'Running a command · git status',
  );
  assert.equal(activityDetail({ folder: 'Projects', extension: 'md' }), 'Projects');
});

test('A finished group is ordered by operation category, then mentions failures', () => {
  const entries = [
    entry('read_document', 'done', { path: 'A.md' }),
    entry('search_vault', 'done', { query: 'stark' }),
    entry('terminal_exec', 'done', { command: 'npm test' }),
  ];
  assert.equal(
    completedActivityLabel(entries, 'zh'),
    '执行了命令，已搜索代码，已读取文件',
  );
  assert.equal(
    completedActivityLabel(entries, 'en'),
    'Ran commands, searched code and read files',
  );
  assert.equal(
    completedActivityLabel([...entries, entry('read_file', 'error', { path: 'B.md' })], 'zh'),
    '执行了命令，已搜索代码，已读取文件 · 1 个操作失败',
  );
  assert.equal(completedActivityLabel([], 'zh'), '已完成');
});
