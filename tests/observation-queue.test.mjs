import test from 'node:test';
import assert from 'node:assert/strict';
import { createObservationQueue } from '../src/observation-queue.js';
import { createTaskEngine } from '../src/task-engine.js';
import { createEvidenceStore } from '../src/evidence-store.js';

// Synthetic observed events and a mock task engine; no RPC or wallet is invoked.
function signature(byte) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (let i = 0; i < 64; i++) n = n * 256n + BigInt(byte);
  let text = '';
  while (n) { text = alphabet[Number(n % 58n)] + text; n /= 58n; }
  return text || '1'.repeat(64);
}
function event(byte = 1, index = 'outer:0', kind = 'mint-instruction', network = 'devnet') {
  return { signature: signature(byte), index, kind, network, finality: 'confirmed' };
}
function mockEngine(initialStatus = 'idle') {
  let state = { status: initialStatus };
  const listeners = new Set();
  const calls = [];
  const completions = [];
  function publish(status) { state = { status }; for (const listener of listeners) listener(state); }
  return {
    calls, getState: () => ({ ...state }),
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    run(request) {
      assert.notEqual(state.status, 'running', 'Must not override a user running task');
      assert.notEqual(state.status, 'replay', 'Must not override user replay');
      calls.push(request);
      publish('running');
      return new Promise(resolve => completions.push(resolve));
    },
    finish(record = { runId: `run-${calls.length}`, outcome: 'completed', trigger: { ...calls.at(-1)?.trigger } }) {
      publish('complete');
      completions.shift()?.(record);
    },
    settle(record) { completions.shift()?.(record); },
    publish,
  };
}
async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve(); }

test('mock queue: inactive until explicitly started, then driven without timers', async () => {
  const engine = mockEngine();
  const queue = createObservationQueue({ engine });
  queue.enqueue([event()]);
  await flush();
  assert.equal(engine.calls.length, 0);
  assert.equal(queue.getState().eventCount, 0);
  queue.start();
  queue.enqueue([event()]);
  await flush();
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].type, 'transaction');
  assert.equal(engine.calls[0].input, event().signature);
  assert.equal(engine.calls[0].trigger.kind, 'session-observation');
  queue.destroy();
  engine.finish();
});

test('mock queue: distinct instruction events share one inspection and finality never reruns it', async () => {
  const engine = mockEngine();
  const completed = [];
  const queue = createObservationQueue({ engine, onComplete: (record, context) => { completed.push({ record, context }); } });
  queue.start();
  queue.enqueue([event(), event(1, 'inner:0:0'), event(1, 'balance:0', 'mint-balance-change')]);
  await flush();
  assert.equal(engine.calls.length, 1);
  assert.equal(queue.getState().eventCount, 3);
  engine.finish();
  await flush();
  queue.enqueue([event(), { ...event(1, 'inner:0:0'), finality: 'finalized' }]);
  await flush();
  assert.equal(engine.calls.length, 1);
  assert.equal(completed[0].context.eventIds.length, 3);
  assert.equal(completed[0].record.trigger.eventIds.length, 3);
  assert.deepEqual(completed[0].record.trigger.eventIds, completed[0].context.eventIds);
  assert.equal(queue.getState().events.every(item => item.runId === 'run-1'), true);
  assert.equal(queue.getState().events[1].finality, 'finalized');
  queue.destroy();
});

test('mock queue: a later new event in an already inspected signature retains its own identity', async () => {
  const engine = mockEngine();
  const queue = createObservationQueue({ engine });
  queue.start(); queue.enqueue([event()]); await flush(); engine.finish(); await flush();
  queue.enqueue([event(1, 'outer:2')]); await flush();
  assert.equal(engine.calls.length, 1);
  assert.equal(queue.getState().eventCount, 2);
  assert.equal(queue.getState().events[1].runId, 'run-1');
  queue.destroy();
});

test('mock queue: additional distinct events arriving during the read join its persisted trigger', async () => {
  const engine = mockEngine();
  let saved;
  const queue = createObservationQueue({ engine, onComplete: record => { saved = record; } });
  queue.start(); queue.enqueue([event()]); await flush();
  queue.enqueue([event(1, 'inner:0:0')]);
  engine.finish(); await flush();
  assert.equal(engine.calls.length, 1);
  assert.equal(saved.trigger.eventIds.length, 2);
  assert.equal(new Set(saved.trigger.eventIds).size, 2);
  queue.destroy();
});

test('mock queue: running user tasks and replay have priority; completion drains one at a time', async () => {
  for (const status of ['running', 'replay']) {
    const engine = mockEngine(status);
    const queue = createObservationQueue({ engine });
    queue.start(); queue.enqueue([event(1), event(2)]); await flush();
    assert.equal(engine.calls.length, 0);
    assert.equal(queue.getState().pendingCount, 2);
    engine.publish('complete'); await flush();
    assert.equal(engine.calls.length, 1);
    engine.finish(); await flush();
    assert.equal(engine.calls.length, 2);
    engine.finish(); await flush();
    assert.equal(queue.getState().status, 'idle');
    queue.destroy();
  }
});

test('mock queue: pending signatures are bounded at 20 and overflow is explicit', async () => {
  const engine = mockEngine('running');
  const queue = createObservationQueue({ engine });
  queue.start();
  const state = queue.enqueue(Array.from({ length: 21 }, (_, i) => event(i + 1)));
  assert.equal(state.pendingCount, 20);
  assert.equal(state.eventCount, 21);
  assert.equal(state.gapCount, 1);
  assert.equal(state.gaps[0].code, 'QUEUE_LIMIT');
  assert.equal(state.events[20].queueStatus, 'not-queued');
  await flush(); assert.equal(engine.calls.length, 0);
  queue.destroy();
});

test('mock queue: stop clears pending events without cancelling the user engine', async () => {
  const engine = mockEngine('running');
  const queue = createObservationQueue({ engine });
  queue.start(); queue.enqueue([event(1), event(2)]); queue.stop();
  engine.publish('complete'); await flush();
  assert.equal(engine.calls.length, 0);
  assert.equal(queue.getState().pendingCount, 0);
  assert.equal(queue.getState().events.every(item => item.queueStatus === 'cancelled'), true);
  queue.enqueue([event(3)]); await flush();
  assert.equal(engine.calls.length, 0);
  queue.destroy();
});

test('mock queue: stop during its current query prevents the next queued query', async () => {
  const engine = mockEngine();
  const queue = createObservationQueue({ engine });
  queue.start(); queue.enqueue([event(1), event(2)]); await flush();
  queue.stop(); engine.finish(); await flush();
  assert.equal(engine.calls.length, 1);
  assert.equal(queue.getState().status, 'stopped');
  queue.destroy();
});

test('mock queue: a user query replacing its current read delays the next queued read', async () => {
  const engine = mockEngine();
  const queue = createObservationQueue({ engine });
  queue.start(); queue.enqueue([event(1), event(2)]); await flush();
  engine.publish('running'); // User query supersedes the current observation read.
  engine.settle(null); await flush();
  assert.equal(engine.calls.length, 1);
  assert.equal(queue.getState().events[0].queueStatus, 'cancelled');
  engine.publish('complete'); await flush();
  assert.equal(engine.calls.length, 2);
  queue.destroy(); engine.finish();
});

test('mock queue: same signature on different networks creates separate read requests', async () => {
  const engine = mockEngine();
  const queue = createObservationQueue({ engine });
  queue.start(); queue.enqueue([event(), event(1, 'outer:0', 'mint-instruction', 'mainnet-beta')]); await flush();
  engine.finish(); await flush();
  assert.equal(engine.calls.length, 2);
  assert.notEqual(engine.calls[0].network, engine.calls[1].network);
  queue.destroy(); engine.finish();
});

test('mock queue: synchronous engine completion cannot recursively double-drain', async () => {
  const listeners = new Set();
  const calls = [];
  const engine = {
    getState: () => ({ status: 'complete' }),
    subscribe(listener) { listeners.add(listener); listener({ status: 'complete' }); return () => listeners.delete(listener); },
    async run(request) { calls.push(request); for (const listener of listeners) listener({ status: 'complete' }); return { runId: `sync-${calls.length}` }; },
  };
  const queue = createObservationQueue({ engine });
  queue.start(); queue.enqueue([event(1), event(2), event(3)]);
  await flush(); await flush();
  assert.equal(calls.length, 3);
  assert.equal(queue.getState().pendingCount, 0);
  queue.destroy();
});

test('mock queue: invalid references do not start engine queries', async () => {
  const engine = mockEngine();
  const queue = createObservationQueue({ engine });
  queue.start();
  queue.enqueue([{ ...event(), signature: 'invalid' }, { ...event(), network: 'ethereum' }]); await flush();
  assert.equal(engine.calls.length, 0);
  assert.equal(queue.getState().gaps.length, 2);
  queue.destroy();
});

test('mock source integration: the real task engine persists one record with every observed event identity', async () => {
  const store = createEvidenceStore({ indexedDB: null });
  let readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  let releaseRead;
  const release = new Promise(resolve => { releaseRead = resolve; });
  let completed;
  const processed = new Promise(resolve => { completed = resolve; });
  const engine = createTaskEngine({ store, services: { inspectTransaction: async input => {
    readStarted(); await release;
    return { kind: 'transaction', summary: { taskStatus: 'completed', input, network: 'devnet', chainStatus: 'failed', finality: 'confirmed' },
      checks: [{ id: 'mock-source', status: 'pass', title: 'Mock read returned', finding: 'Synthetic fixture was parsed.', evidence: ['raw.mock'] }],
      raw: { mock: true }, observedAt: '2026-10-14T00:00:00.000Z', dataSource: 'Mock source', evidenceRefs: [{ path: 'raw.mock' }] };
  } } });
  const queue = createObservationQueue({ engine, onComplete: record => completed(record) });
  queue.start(); queue.enqueue([event()]); await started;
  queue.enqueue([event(1, 'inner:0:0')]); releaseRead();
  const record = await processed;
  const saved = await store.getRecord(record.runId);
  assert.equal((await store.listRecords()).length, 1);
  assert.equal(saved.trigger.kind, 'session-observation');
  assert.equal(saved.trigger.eventIds.length, 2);
  assert.deepEqual(saved.trigger.eventIds, queue.getState().events.map(item => item.eventId));
  assert.equal(saved.chainExecution.initiatedByApplication, false);
  assert.equal(saved.chainExecution.status, 'failed');
  queue.destroy(); engine.destroy();
});
