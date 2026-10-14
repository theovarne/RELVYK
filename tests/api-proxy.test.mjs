import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpcHandler } from '../api/rpc.js';
const OWNER = '11111111111111111111111111111111';
const TIME = '2026-10-14T08:00:00.000Z';
// Tests below use explicit fake HTTP providers. No RPC call or funded operation occurs.

function responseRecorder() {
  return { statusCode: null, headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
}
const request = (method = 'getBalance', params = [OWNER, { commitment: 'confirmed' }]) => ({ method: 'POST', headers: {}, body: { method, params, network: 'devnet' } });

test('proxy rejects non-POST requests, malformed JSON, oversized requests and malformed method arguments', async () => {
  let reads = 0;
  const handler = createRpcHandler({ env: {}, fetchImpl: async () => { reads++; throw new Error('Unexpected provider read'); } });
  for (const invalid of [
    { ...request(), method: 'GET' },
    { ...request(), body: '{invalid' },
    { ...request(), body: [] },
    { ...request(), body: { method: 'getBalance', network: 'devnet', params: ['1'.repeat(9000), {}] } },
    request('getBalance', [OWNER]),
    request('getAccountInfo', [OWNER, { encoding: 'binary', commitment: 'confirmed' }]),
    request('getSignatureStatuses', [[], { searchTransactionHistory: true }]),
    request('getTokenAccountsByOwner', [OWNER, { programId: OWNER }, { encoding: 'jsonParsed' }]),
    request('getSlot', [{ commitment: 'processed' }]),
  ]) {
    const res = responseRecorder(); await handler(invalid, res);
    assert.ok([400, 405].includes(res.statusCode));
    if (invalid.method === 'GET') assert.equal(res.headers.allow, 'POST');
    assert.equal(res.body.error.retryable, false);
  }
  assert.equal(reads, 0);
});

test('proxy rejects writable methods and arbitrary client URL keys before touching a provider', async () => {
  let requests = 0;
  const handler = createRpcHandler({ fetchImpl: async () => { requests++; throw new Error('unexpected'); }, env: {} });
  const writable = responseRecorder(); await handler(request('sendTransaction', ['payload']), writable);
  assert.equal(writable.statusCode, 400);
  const arbitrary = request(); arbitrary.body.url = 'http://127.0.0.1';
  const res = responseRecorder(); await handler(arbitrary, res);
  assert.equal(res.statusCode, 400); assert.equal(requests, 0);
});
test('proxy accepts the numeric version 1 ceiling without transforming it into a string', async () => {
  let wireRequest;
  const handler = createRpcHandler({ env: {}, fetchImpl: async (url, options) => { wireRequest = JSON.parse(options.body); return new Response('{"jsonrpc":"2.0","result":null}'); } });
  const res = responseRecorder();
  await handler(request('getTransaction', ['1'.repeat(64), { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }]), res);
  assert.equal(res.statusCode, 200);
  assert.equal(wireRequest.params[1].maxSupportedTransactionVersion, 1);
  assert.equal(typeof wireRequest.params[1].maxSupportedTransactionVersion, 'number');
});
test('proxy dedupes concurrent reads, preserves unsafe numbers, and retains cache observation time without leaking keys', async () => {
  let requests = 0, finish, clock = Date.parse(TIME);
  const handler = createRpcHandler({ env: { SOLANA_DEVNET_RPC_URL: 'https://provider.example/?api-key=SECRET-TEST-KEY' }, now: () => clock, fetchImpl: async () => { requests++; await new Promise(resolve => finish = resolve); return new Response('{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":100},"value":9007199254740993}}', { status: 200 }); } });
  const first = responseRecorder(), second = responseRecorder();
  const a = handler(request(), first), b = handler(request(), second); finish(); await Promise.all([a, b]);
  assert.equal(requests, 1); assert.equal(first.body.result.value, '9007199254740993');
  assert.equal(first.body.dataSource, 'Configured devnet RPC');
  assert.equal(JSON.stringify(first.body).includes('SECRET-TEST-KEY'), false);
  clock += 1000; const cached = responseRecorder(); await handler(request(), cached);
  assert.equal(cached.body.cache.hit, true); assert.equal(cached.body.cache.ageMs, 1000); assert.equal(cached.body.observedAt, TIME); assert.equal(requests, 1);
});
test('proxy makes only one bounded retry for rate limits and returns actionable sanitized errors', async () => {
  let requests = 0;
  const handler = createRpcHandler({ env: {}, fetchImpl: async () => { requests++; return new Response('Do not expose provider detail', { status: 429, headers: { 'retry-after': '0.001' } }); } });
  const res = responseRecorder(); await handler(request(), res);
  assert.equal(requests, 2); assert.equal(res.statusCode, 429); assert.equal(res.body.error.code, 'RATE_LIMITED');
  assert.equal(res.body.error.retryable, true); assert.match(res.body.error.message, /retry/);
});
test('proxy rejects oversized source responses and sanitizes provider error messages', async () => {
  const tooLarge = createRpcHandler({ env: {}, fetchImpl: async () => new Response('x', { status: 200, headers: { 'content-length': String(4 * 1024 * 1024) } }) });
  const largeRes = responseRecorder(); await tooLarge(request(), largeRes);
  assert.equal(largeRes.body.error.code, 'RESPONSE_TOO_LARGE');
  const unsupported = createRpcHandler({ env: {}, fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32015, message: 'SECRET=https://provider.example/private' } }), { status: 200 }) });
  const res = responseRecorder(); await unsupported(request(), res);
  assert.equal(res.body.error.code, 'UNSUPPORTED_VERSION'); assert.equal(JSON.stringify(res.body).includes('SECRET'), false);
});
test('proxy aborts timed-out reads and expires cached reads instead of moving their timestamp forward', async () => {
  const timeout = createRpcHandler({ env: {}, requestTimeoutMs: 5, fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Synthetic abort', 'AbortError')), { once: true })) });
  const timedOut = responseRecorder(); await timeout(request(), timedOut);
  assert.equal(timedOut.statusCode, 504); assert.equal(timedOut.body.error.code, 'RPC_TIMEOUT');
  let clock = Date.parse(TIME), requests = 0;
  const cache = createRpcHandler({ env: {}, now: () => clock, fetchImpl: async () => { requests++; return new Response('{"jsonrpc":"2.0","result":{"context":{"slot":1},"value":12}}'); } });
  const first = responseRecorder(); await cache(request(), first);
  clock += 2500; const second = responseRecorder(); await cache(request(), second);
  assert.equal(requests, 2); assert.equal(second.body.cache.hit, false); assert.notEqual(second.body.observedAt, first.body.observedAt);
});

test('proxy bounds streamed response bytes without trusting content-length and rejects invalid response structures', async () => {
  const tooLarge = createRpcHandler({ env: {}, fetchImpl: async () => new Response('x'.repeat(3 * 1024 * 1024 + 1)) });
  const large = responseRecorder(); await tooLarge(request(), large);
  assert.equal(large.body.error.code, 'RESPONSE_TOO_LARGE');
  for (const source of ['not-json', '{"jsonrpc":"1.0","result":12}', '{"jsonrpc":"2.0","id":1}']) {
    const invalid = createRpcHandler({ env: {}, fetchImpl: async () => new Response(source) });
    const res = responseRecorder(); await invalid(request(), res);
    assert.equal(res.statusCode, 502); assert.equal(res.body.error.code, 'INVALID_RESPONSE');
  }
});
test('proxy does not expose configured endpoint details in HTTP failures, RPC errors, or configuration failures', async () => {
  const key = 'PRIVATE-KEY-DO-NOT-EXPOSE';
  for (const source of [
    new Response(`https://provider.example/?api-key=${key}`, { status: 403 }),
    new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: key } })),
  ]) {
    const handler = createRpcHandler({ env: { SOLANA_DEVNET_RPC_URL: `https://provider.example/?api-key=${key}` }, fetchImpl: async () => source });
    const res = responseRecorder(); await handler(request(), res);
    assert.equal(res.statusCode, 502); assert.equal(JSON.stringify(res.body).includes(key), false);
    assert.equal(JSON.stringify(res.body).includes('provider.example'), false);
  }
  const invalid = createRpcHandler({ env: { SOLANA_DEVNET_RPC_URL: `http://provider.example/?api-key=${key}` } });
  const res = responseRecorder(); await invalid(request(), res);
  assert.equal(res.statusCode, 503); assert.equal(res.body.error.code, 'PROVIDER_CONFIGURATION');
  assert.equal(JSON.stringify(res.body).includes(key), false);
});
