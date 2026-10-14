import { parseJSONExact } from './precision.js';
import { validateRpcRequest } from './validation.js';

export class RpcError extends Error {
  constructor(code, message, retryable = false) { super(message); this.name = 'RpcError'; this.code = code; this.retryable = retryable; }
}
const inflight = new Map();
const abortError = () => new DOMException('This inspection was cancelled.', 'AbortError');

/**
 * @typedef {{result: any, observedAt: string, dataSource: string, precision?: string, cache?: {hit?: boolean, ageMs?: number}}} RpcRead
 */

async function readResponse(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > 3 * 1024 * 1024 + 8192) throw new RpcError('RESPONSE_TOO_LARGE', 'The inspection response exceeds the browser limit.');
    return parseJSONExact(text);
  }
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 3 * 1024 * 1024 + 8192) { await reader.cancel(); throw new RpcError('RESPONSE_TOO_LARGE', 'The inspection response exceeds the browser limit.'); }
      text += decoder.decode(value, { stream: true });
    }
    return parseJSONExact(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

async function fetchRead(body, signal) {
  let response;
  try { response = await fetch('/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal, credentials: 'same-origin' }); }
  catch { if (signal.aborted) throw abortError(); throw new RpcError('NETWORK_ERROR', 'The inspection service could not be reached. Retry when your connection is available.', true); }
  let data;
  try { data = await readResponse(response); }
  catch (error) { if (signal.aborted) throw abortError(); if (error instanceof RpcError) throw error; throw new RpcError('INVALID_RESPONSE', 'The inspection service returned unreadable data. Retry the query.', true); }
  if (!response.ok || data?.error) {
    const safe = data?.error;
    throw new RpcError(typeof safe?.code === 'string' ? safe.code : 'RPC_UNAVAILABLE', typeof safe?.message === 'string' ? safe.message.slice(0, 500) : 'The read could not be completed. Retry the query.', Boolean(safe?.retryable) || response.status === 429);
  }
  if (!data || !Object.hasOwn(data, 'result') || typeof data.observedAt !== 'string' || !Number.isFinite(Date.parse(data.observedAt)) || typeof data.dataSource !== 'string') throw new RpcError('INVALID_RESPONSE', 'The inspection service returned an unexpected data structure.', true);
  return data;
}

/**
 * @param {string} method
 * @param {unknown[]} params
 * @param {string} network
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<RpcRead>}
 */
export function rpcWithEvidence(method, params, network, { signal } = {}) {
  validateRpcRequest(method, params, network);
  if (signal?.aborted) return Promise.reject(abortError());
  const body = { method, params, network }, key = JSON.stringify(body);
  let entry = inflight.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, subscribers: 0, done: false, timedOut: false };
    const timer = setTimeout(() => { entry.timedOut = true; controller.abort(); }, 18000);
    entry.promise = fetchRead(body, controller.signal).catch(error => {
      if (entry.timedOut) throw new RpcError('RPC_TIMEOUT', 'The inspection read timed out. Retry the query.', true);
      throw error;
    }).finally(() => { entry.done = true; clearTimeout(timer); if (inflight.get(key) === entry) inflight.delete(key); });
    inflight.set(key, entry);
  }
  entry.subscribers++;
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      if (finished) return false;
      finished = true; signal?.removeEventListener('abort', cancelled); entry.subscribers--;
      if (!entry.done && entry.subscribers === 0) { entry.controller.abort(); if (inflight.get(key) === entry) inflight.delete(key); }
      return true;
    };
    const cancelled = () => { if (cleanup()) reject(abortError()); };
    signal?.addEventListener('abort', cancelled, { once: true });
    entry.promise.then(value => { if (cleanup()) resolve(value); }, error => { if (cleanup()) reject(error); });
  });
}

/**
 * @param {string} method
 * @param {unknown[]} params
 * @param {string} network
 * @param {{signal?: AbortSignal}} [options]
 */
export async function rpc(method, params, network, options = {}) {
  return (await rpcWithEvidence(method, params, network, options)).result;
}
