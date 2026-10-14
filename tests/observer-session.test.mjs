import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionObserver, deriveMintEvents, observerEventKey } from '../src/session-observer.js';

// All observer cases are deterministic mocked RPC responses, not live mint monitoring.
const MINT = 'So11111111111111111111111111111111111111112';
const ADDRESS = '11111111111111111111111111111111';
const OTHER_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const sig = char => char.repeat(64); // 64 decoded bytes for the all-'1' signature; others below use encoder.
function base58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const byte of bytes) n = n * 256n + BigInt(byte);
  let text = '';
  while (n) { text = alphabet[Number(n % 58n)] + text; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; text = '1' + text; }
  return text;
}
const SIGNATURE = base58(new Uint8Array(64).fill(7));
const BASELINE = sig('1');
const signatureRow = (signature = SIGNATURE, finality = 'confirmed') => ({ signature, slot: 12, err: null, blockTime: 1_700_000_000, confirmationStatus: finality });
function transaction(overrides = {}) {
  return { slot: 12, blockTime: 1_700_000_000,
    transaction: { message: { accountKeys: [ADDRESS, OTHER_ADDRESS], instructions: [
      { programId: OTHER_ADDRESS, parsed: { type: 'transferChecked', info: { mint: MINT, amount: '2' } } },
      { programId: OTHER_ADDRESS, parsed: { type: 'transferChecked', info: { mint: MINT, amount: '3' } } },
    ] } },
    meta: { err: null, innerInstructions: [{ index: 0, instructions: [{ programId: OTHER_ADDRESS,
      parsed: { type: 'transferChecked', info: { mint: MINT, amount: '1' } } }] }],
    preTokenBalances: [{ accountIndex: 0, mint: MINT, uiTokenAmount: { amount: '9007199254740993000', decimals: 9 } }],
    postTokenBalances: [{ accountIndex: 0, mint: MINT, uiTokenAmount: { amount: '9007199254740993001', decimals: 9 } }] }, ...overrides };
}
function options(rpc, extra = {}) {
  return { tokenConfig: { mint: MINT, network: 'devnet' }, rpc, target: null,
    setTimer: () => 1, clearTimer: () => {}, now: () => '2026-10-14T00:00:00.000Z', ...extra };
}

test('mock: unconfigured project mint keeps observation disabled and makes no RPC request', async () => {
  let reads = 0;
  const observer = createSessionObserver(options(async () => { reads++; }, { tokenConfig: { mint: null } }));
  assert.equal(observer.getState().status, 'disabled');
  await observer.start({ accounts: [ADDRESS] });
  await observer.poll();
  assert.equal(reads, 0);
  assert.equal(observer.getState().error.code, 'MINT_NOT_CONFIGURED');
  observer.destroy();
});

test('mock: observer rejects invalid and unbounded account scope', async () => {
  const observer = createSessionObserver(options(async () => []));
  await assert.rejects(observer.start({ accounts: [] }), /one and 3/);
  await assert.rejects(observer.start({ accounts: [ADDRESS, ADDRESS, ADDRESS, ADDRESS] }), /one and 3/);
  await assert.rejects(observer.start({ accounts: ['invalid'] }), /valid Solana/);
  observer.destroy();
});

test('mock: initial read establishes cursor without importing historical events', async () => {
  const calls = [];
  const observer = createSessionObserver(options(async (method, params) => { calls.push({ method, params }); return [signatureRow(BASELINE)]; }));
  await observer.start({ accounts: [ADDRESS] });
  assert.equal(observer.getState().events.length, 0);
  assert.equal(observer.getState().cursors[ADDRESS], BASELINE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[1].limit, 20);
  observer.destroy();
});

test('mock: empty baseline accepts later activity without sending an invalid until cursor', async () => {
  let reads = 0;
  const observer = createSessionObserver(options(async (method, params) => {
    if (method === 'getSignaturesForAddress') { reads++; assert.equal(params[1].until, undefined); return reads === 1 ? [] : [signatureRow()]; }
    if (method === 'getTransaction') return transaction();
    return { value: [{ confirmationStatus: 'confirmed' }] };
  }));
  await observer.start({ accounts: [ADDRESS] });
  await observer.poll();
  assert.equal(observer.getState().events.length, 4);
  observer.destroy();
});

test('mock: each instruction and balance event survives dedupe; repeated signatures do not increase count', async () => {
  let reads = 0;
  let details = 0;
  const observer = createSessionObserver(options(async (method, params) => {
    if (method === 'getSignaturesForAddress') return ++reads === 1 ? [signatureRow(BASELINE)] : [signatureRow(), signatureRow()];
    if (method === 'getTransaction') { details++; assert.equal(params[1].maxSupportedTransactionVersion, 1); return transaction({ version: 1 }); }
    return { value: [{ confirmationStatus: 'confirmed' }] };
  }));
  await observer.start({ accounts: [ADDRESS] });
  await observer.poll();
  await observer.poll();
  assert.equal(details, 1);
  assert.equal(observer.getState().events.length, 4);
  assert.equal(new Set(observer.getState().events.map(observerEventKey)).size, 4);
  assert.equal(observer.getState().events[3].evidence.postAmount, '9007199254740993001');
  observer.destroy();
});

test('mock: finality update preserves event identity and transaction failure remains explicit', async () => {
  let reads = 0;
  let statusReads = 0;
  const failed = transaction();
  failed.meta.err = { InstructionError: [0, 'Custom'] };
  const observer = createSessionObserver(options(async method => {
    if (method === 'getSignaturesForAddress') return ++reads === 1 ? [signatureRow(BASELINE)] : [signatureRow()];
    if (method === 'getTransaction') return failed;
    return { value: [{ confirmationStatus: ++statusReads === 1 ? 'confirmed' : 'finalized' }] };
  }));
  await observer.start({ accounts: [ADDRESS] });
  await observer.poll();
  assert.equal(observer.getState().events[0].finality, 'confirmed');
  await observer.poll();
  assert.equal(observer.getState().events.length, 4);
  assert.equal(observer.getState().events[0].finality, 'finalized');
  assert.deepEqual(observer.getState().events[0].chainError, failed.meta.err);
  observer.destroy();
});

test('mock: rate limit backs off and resume preserves cursor', async () => {
  let reads = 0;
  let delay;
  const optionsSeen = [];
  const observer = createSessionObserver(options(async (method, params) => {
    optionsSeen.push(params[1]);
    reads++;
    if (reads === 2) throw { code: 'RATE_LIMITED' };
    return reads === 1 ? [signatureRow(BASELINE)] : [];
  }, { setTimer: (_, ms) => { delay = ms; return 1; } }));
  await observer.start({ accounts: [ADDRESS] });
  await observer.poll();
  assert.equal(observer.getState().status, 'retrying');
  assert.equal(delay, 30_000);
  observer.stop();
  await observer.start({ accounts: [ADDRESS] });
  assert.equal(optionsSeen[2].until, BASELINE);
  assert.equal(observer.getState().status, 'observing');
  observer.destroy();
});

test('mock: stopping aborts pending reads and prevents stale responses updating state', async () => {
  let resolve;
  let signal;
  const observer = createSessionObserver(options(async (_method, _params, _network, context) => {
    signal = context.signal;
    return new Promise(done => { resolve = done; });
  }));
  const start = observer.start({ accounts: [ADDRESS] });
  await Promise.resolve();
  observer.stop();
  assert.equal(signal.aborted, true);
  resolve([signatureRow(BASELINE)]);
  await start;
  assert.equal(observer.getState().status, 'stopped');
  assert.deepEqual(observer.getState().cursors, {});
  observer.destroy();
});

test('mock: transaction relevance is checked from mint evidence, never only account signature', () => {
  const value = transaction();
  const unrelated = deriveMintEvents(value, { mint: ADDRESS, network: 'devnet', signature: SIGNATURE, account: ADDRESS, finality: 'confirmed', observedAt: '' });
  assert.deepEqual(unrelated, []);
  const unsupported = deriveMintEvents({ slot: 1 }, { mint: MINT });
  assert.deepEqual(unsupported, []);
});

test('mock: foreground-only observer pauses and resumes with existing session cursor', async () => {
  class MockDocument extends EventTarget { hidden = true; }
  const target = new MockDocument();
  let reads = 0;
  const observer = createSessionObserver(options(async () => { reads++; return [signatureRow(BASELINE)]; }, { target }));
  await observer.start({ accounts: [ADDRESS] });
  assert.equal(reads, 0);
  assert.equal(observer.getState().status, 'paused');
  target.hidden = false;
  target.dispatchEvent(new Event('visibilitychange'));
  await observer.poll();
  assert.equal(reads, 1);
  target.hidden = true;
  target.dispatchEvent(new Event('visibilitychange'));
  assert.equal(observer.getState().status, 'paused');
  observer.destroy();
});
