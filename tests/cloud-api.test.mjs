import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
globalThis.location = { hash: '' };
let invoke, signInCount = 0;
globalThis.window = {
  SCOREKEEPER_CONFIG: { envId: 'cloud-test' },
  addEventListener() {},
  cloudbase: { init: () => ({
    auth: () => ({ getLoginState: async () => ({ user: 'cached' }), signInAnonymously: async () => { signInCount++; } }),
    callFunction: request => invoke(request),
  }) },
};
globalThis.document = { createElement: () => ({}), head: { append: script => queueMicrotask(() => script.onload()) } };
const { api } = await import('../public/api.mjs');

test('expired cached identity is renewed once before a successful read', async () => {
  let calls = 0;
  invoke = async () => { if (++calls === 1) throw { code: 'AUTH_EXPIRED', errMsg: 'token expired' }; return { result: { users: [] } }; };
  assert.deepEqual(await api('listUsers'), { users: [] });
  assert.equal(calls, 2);
  assert.equal(signInCount, 1);
});

test('SDK errors without an Error.message still produce an actionable message', async () => {
  invoke = async () => { throw { code: 'SERVICE_UNAVAILABLE', errMsg: '云服务暂不可用' }; };
  await assert.rejects(api('listGames'), error => error.message === '云服务暂不可用' && error.code === 'SERVICE_UNAVAILABLE');
});

test('disabled anonymous login reports configuration failure without pointless retries', async () => {
  let calls = 0;
  invoke = async () => { calls++; throw { code: 'LOGIN_TYPE_DISABLED' }; };
  await assert.rejects(api('listUsers'), /访客登录已停用/);
  assert.equal(calls, 1);
  assert.equal(signInCount, 1);
});

test('uncertain network writes and management-key failures are never replayed', async () => {
  let calls = 0;
  invoke = async () => { calls++; throw { code: 'NETWORK_ERROR', errMsg: 'failed to fetch' }; };
  await assert.rejects(api('createGame'), /网络/);
  assert.equal(calls, 1);
  invoke = async () => { calls++; return { result: { error: { code: 'UNAUTHORIZED', message: '管理密钥无效' } } }; };
  await assert.rejects(api('addRound'), /管理密钥/);
  assert.equal(calls, 2);
  assert.equal(signInCount, 1);
});
