import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api } from './harness.mjs';

beforeEach(() => {
  globalThis.__providerRequest = async () => ({ status: 404, json: {} });
});

test('About release check: numeric versions, updates, current releases and invalid URLs', async () => {
  assert.ok(api.compareVersions('0.2.0', '0.1.9') > 0);
  assert.ok(api.compareVersions('0.1.0-beta', '0.1.0') < 0);

  globalThis.__providerRequest = async () => ({
    status: 200,
    json: {
      tag_name: 'v0.2.0',
      html_url: 'https://github.com/SuShuheng/obsidian-stark/releases/tag/v0.2.0',
    },
  });
  const update = await api.checkLatestRelease('0.1.0');
  assert.equal(update.status, 'update');
  assert.equal(update.release.version, '0.2.0');

  globalThis.__providerRequest = async () => ({
    status: 200,
    json: {
      tag_name: 'v0.1.0',
      html_url: 'https://github.com/SuShuheng/obsidian-stark/releases/tag/v0.1.0',
    },
  });
  assert.equal((await api.checkLatestRelease('0.1.0')).status, 'current');

  globalThis.__providerRequest = async () => ({
    status: 200,
    json: { tag_name: 'v0.2.0', html_url: 'https://evil.example/release' },
  });
  assert.equal((await api.checkLatestRelease('0.1.0')).status, 'error');
});

test('About release check: no release, rate limits and network failures are reported without throwing', async () => {
  globalThis.__providerRequest = async () => ({ status: 404, json: {} });
  assert.deepEqual(await api.checkLatestRelease('0.1.0'), { status: 'no-release' });

  globalThis.__providerRequest = async () => ({
    status: 403,
    headers: { 'x-ratelimit-remaining': '0' },
    json: {},
  });
  const limited = await api.checkLatestRelease('0.1.0');
  assert.equal(limited.status, 'error');
  assert.match(limited.message, /rate limit/);

  globalThis.__providerRequest = async () => { throw new Error('network down'); };
  const failed = await api.checkLatestRelease('0.1.0');
  assert.deepEqual(failed, { status: 'error', message: 'network down' });
});
