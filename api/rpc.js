import { parseJSONExact } from '../src/solana/precision.js';
import { PUBLIC_RPC, validateRpcRequest } from '../src/solana/validation.js';

const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const MAX_REQUEST_BYTES = 8192;
const ENV_KEYS = { 'mainnet-beta': 'SOLANA_MAINNET_RPC_URL', devnet: 'SOLANA_DEVNET_RPC_URL', testnet: 'SOLANA_TESTNET_RPC_URL' };
const safeError = (status, code, message, retryable = false) => Object.assign(new Error(message), { status, code, retryable });

async function boundedText(response, limit = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) { await response.body?.cancel(); throw safeError(502, 'RESPONSE_TOO_LARGE', 'The data source response exceeds the inspection limit. Try a smaller account scope.'); }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > limit) throw safeError(502, 'RESPONSE_TOO_LARGE', 'The data source response exceeds the inspection limit.');
    return text;
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw safeError(502, 'RESPONSE_TOO_LARGE', 'The data source response exceeds the inspection limit. Try a smaller account scope.'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

function cacheTTL(method, result) {
  if (result === null) return 2000;
  if (method === 'getTransaction') return 10000;
  return 2000;
}

// These caches and rate counters are bounded, best-effort, and local to one
// warm Function instance. They are never described as a global service quota.
/**
 * @param {{fetchImpl?: typeof fetch, now?: () => number, env?: Record<string, string | undefined>, requestTimeoutMs?: number}} [options]
 */
export function createRpcHandler({ fetchImpl = (input, init) => fetch(input, init), now = () => Date.now(), env = process.env, requestTimeoutMs = 6500 } = {}) {
  const cache = new Map(), pending = new Map(), buckets = new Map();
  function boundedSet(map, key, value, maximum) {
    if (map.size >= maximum) map.delete(map.keys().next().value);
    map.set(key, value);
  }
  async function upstream(method, params, network) {
    const configured = env[ENV_KEYS[network]], endpoint = configured || PUBLIC_RPC[network];
    let url;
    try { url = new URL(endpoint); } catch { throw safeError(503, 'PROVIDER_CONFIGURATION', 'The selected network data provider is unavailable.'); }
    if (url.protocol !== 'https:') throw safeError(503, 'PROVIDER_CONFIGURATION', 'The selected network data provider is unavailable.');
    const started = now();
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetchImpl(url.href, {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: controller.signal, redirect: 'error',
        });
        if (response.status === 429 || response.status >= 500) {
          await response.body?.cancel();
          if (attempt === 0 && now() - started < 8000) {
            const retryAfter = Number(response.headers.get('retry-after'));
            clearTimeout(timer);
            await new Promise(resolve => setTimeout(resolve, Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 350, 1000)));
            continue;
          }
          throw safeError(response.status === 429 ? 429 : 502, response.status === 429 ? 'RATE_LIMITED' : 'RPC_UNAVAILABLE', response.status === 429 ? 'The Solana data provider is rate limiting reads. Wait briefly and retry.' : 'The Solana data provider could not complete this read. Retry the query.', true);
        }
        if (!response.ok) { await response.body?.cancel(); throw safeError(502, 'RPC_UNAVAILABLE', 'The selected Solana data provider rejected the read. Retry or choose another network.', true); }
        let wire;
        try { wire = parseJSONExact(await boundedText(response)); } catch (error) {
          if (error.code || error.name === 'AbortError') throw error;
          throw safeError(502, 'INVALID_RESPONSE', 'The Solana data source returned unreadable JSON.', true);
        }
        if (!wire || wire.jsonrpc !== '2.0' || (!Object.hasOwn(wire, 'result') && !wire.error)) throw safeError(502, 'INVALID_RESPONSE', 'The Solana data source returned an unexpected response.', true);
        if (wire.error) {
          const unsupported = wire.error.code === -32015;
          throw safeError(502, unsupported ? 'UNSUPPORTED_VERSION' : 'RPC_ERROR', unsupported ? 'This transaction version exceeds the requested supported version ceiling. This inspector supports legacy, version 0, and version 1 transactions.' : `The Solana data source could not return this read (RPC code ${Number.isSafeInteger(wire.error.code) ? wire.error.code : 'unavailable'}). Check the input and retry.`, !unsupported);
        }
        return { result: wire.result, observedAt: new Date(now()).toISOString(), dataSource: `${configured ? 'Configured' : 'Solana public'} ${network} RPC`, precision: 'Unsafe JSON integers are preserved as decimal strings.' };
      } catch (error) {
        if (error.name === 'AbortError') throw safeError(504, 'RPC_TIMEOUT', 'The Solana data source timed out. Retry the query.', true);
        if (error.code && error.status) throw error;
        if (attempt === 0 && now() - started < 8000) continue;
        throw safeError(502, 'RPC_UNAVAILABLE', 'The Solana data source could not be reached. Retry the query.', true);
      } finally { clearTimeout(timer); }
    }
  }
  return async function handler(req, res) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for read-only inspections.', retryable: false } }); }
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['method', 'params', 'network'].includes(key)) || Buffer.byteLength(JSON.stringify(body)) > MAX_REQUEST_BYTES) throw safeError(400, 'INVALID_REQUEST', 'Use a supported network, read-only method, and bounded parameters.');
      try { validateRpcRequest(body.method, body.params, body.network); } catch (error) { throw safeError(400, 'INVALID_REQUEST', error.message); }
      const ip = String(req.headers?.['x-real-ip'] || req.socket?.remoteAddress || 'local').slice(0, 128);
      const bucket = buckets.get(ip);
      if (bucket && now() - bucket.start < 60000) {
        if (++bucket.count > 60) { res.setHeader('retry-after', '30'); throw safeError(429, 'PROXY_LIMIT', 'Too many inspection reads from this client. Wait briefly and retry.', true); }
      } else boundedSet(buckets, ip, { start: now(), count: 1 }, 1024);
      const { method, params, network } = body, key = JSON.stringify(body), entry = cache.get(key);
      if (entry && now() - entry.timestamp < entry.ttl) return res.status(200).json({ ...entry.value, cache: { hit: true, ageMs: Math.max(0, now() - entry.timestamp) } });
      if (pending.size >= 64 && !pending.has(key)) throw safeError(503, 'BUSY', 'The inspection service is busy. Retry shortly.', true);
      let promise = pending.get(key);
      if (!promise) {
        promise = upstream(method, params, network).then(value => {
          boundedSet(cache, key, { value, timestamp: now(), ttl: cacheTTL(method, value.result) }, 128);
          return value;
        });
        pending.set(key, promise);
      }
      try { return res.status(200).json({ ...(await promise), cache: { hit: false, ageMs: 0 } }); }
      finally { if (pending.get(key) === promise) pending.delete(key); }
    } catch (error) {
      const known = error.code && error.status;
      return res.status(known ? error.status : 400).json({ error: { code: known ? error.code : 'INVALID_REQUEST', message: known ? error.message : 'The inspection request could not be read.', retryable: known ? Boolean(error.retryable) : false } });
    }
  };
}

export default createRpcHandler();
