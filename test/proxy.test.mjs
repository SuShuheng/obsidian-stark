import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { api, response, settings, text } from './harness.mjs';

afterEach(() => {
  api.resetProxyCache();
  globalThis.__isDesktopApp = false;
  globalThis.window = globalThis;
  api.setChatGPTOAuthService(null);
});

test('Proxy settings: manual URLs normalize, mobile never uses the desktop proxy, and direct is off', async () => {
  assert.equal(api.normalizeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890/');
  assert.equal(api.normalizeProxyUrl('http=127.0.0.1:7890;https=127.0.0.1:7891'), 'http://127.0.0.1:7891/');
  assert.equal(api.normalizeProxyUrl('socks5://127.0.0.1:7890'), undefined);
  assert.equal(api.normalizeProxyUrl('http://user:secret@127.0.0.1:7890'), undefined);
  assert.equal(api.normalizeProxyUrl(''), undefined);

  globalThis.__isDesktopApp = true;
  assert.equal(await api.proxyForUrl('https://chatgpt.com', {
    mode: 'direct', url: 'http://127.0.0.1:7890',
  }), undefined);
  assert.equal(await api.proxyForUrl('https://chatgpt.com', {
    mode: 'manual', url: '127.0.0.1:7890',
  }), 'http://127.0.0.1:7890/');

  globalThis.__isDesktopApp = false;
  assert.equal(await api.proxyForUrl('https://chatgpt.com', {
    mode: 'manual', url: 'http://127.0.0.1:7890',
  }), undefined);
});

test('System proxy: Windows Internet Settings are read through the desktop Node loader', async () => {
  const originalIsWin = api.Platform.isWin;
  api.Platform.isWin = true;
  globalThis.__isDesktopApp = true;
  globalThis.window = {
    require(id) {
      if (id !== 'child_process') return undefined;
      return {
        execFile(file, args, options, callback) {
          const value = args.includes('ProxyEnable')
            ? 'ProxyEnable    REG_DWORD    0x1'
            : 'ProxyServer    REG_SZ    127.0.0.1:7897';
          queueMicrotask(() => callback(null, value));
        },
      };
    },
  };
  api.resetProxyCache();
  try {
    assert.equal(
      await api.proxyForUrl('https://chatgpt.com', { mode: 'system' }),
      'http://127.0.0.1:7897/',
    );
  } finally {
    if (originalIsWin === undefined) delete api.Platform.isWin;
    else api.Platform.isWin = originalIsWin;
    api.resetProxyCache();
  }
});

test('ChatGPT streaming carries the selected desktop proxy through the CONNECT tunnel', async () => {
  const proxyCalls = [];
  const targetCalls = [];
  const raw = {
    destroy() {},
    unshift() {},
    on() {},
  };
  const secure = {
    once(event, listener) {
      if (event === 'secureConnect') queueMicrotask(listener);
      return secure;
    },
    on() { return secure; },
    destroy() {},
    unshift() {},
  };
  const http = {
    request(options) {
      proxyCalls.push(options);
      const request = {
        on(event, listener) {
          if (event === 'connect') queueMicrotask(() => listener({ statusCode: 200 }, raw, Buffer.alloc(0)));
          return request;
        },
        end() {},
        destroy() {},
      };
      return request;
    },
  };
  const tls = { connect() { return secure; } };
  const body = response('chatgpt-oauth', [text('OK')]).text;
  class Agent {
    constructor(options) { this.options = options; }
    createConnection() { return secure; }
  }
  const https = {
    Agent,
    request(url, options, callback) {
      targetCalls.push({ url, options });
      const listeners = {};
      const request = {
        write() {},
        end() {
          const res = {
            statusCode: 200,
            headers: {},
            setEncoding() {},
            on(event, listener) { (listeners[event] ??= []).push(listener); },
          };
          callback(res);
          queueMicrotask(() => {
            for (const listener of listeners.data ?? []) listener(body);
            for (const listener of listeners.end ?? []) listener();
          });
        },
        on() {},
        destroy() {},
      };
      return request;
    },
  };
  globalThis.__isDesktopApp = true;
  globalThis.window = {
    require(id) {
      return { http, https, tls }[id];
    },
  };
  api.setChatGPTOAuthService({
    getUsableCredential: async () => ({ accessToken: 'token', accountId: 'account' }),
    renewRejected: async () => undefined,
  });

  const result = await api.sendChatGPTOAuthMessage(
    { ...settings('chatgpt-oauth'), model: 'gpt-5.5', thinkingLevel: '' },
    [{ role: 'user', content: 'Hello' }],
    [],
    'System',
    () => false,
    { proxy: { mode: 'manual', url: 'http://127.0.0.1:7890' } },
  );
  assert.equal(result.content[0].text, 'OK');
  assert.equal(proxyCalls.length, 1);
  assert.equal(proxyCalls[0].method, 'CONNECT');
  assert.equal(proxyCalls[0].path, 'chatgpt.com:443');
  assert.equal(targetCalls.length, 1);
  assert.equal(targetCalls[0].options.agent.options.keepAlive, false);
  assert.equal(typeof targetCalls[0].options.agent.createConnection, 'function');
});
