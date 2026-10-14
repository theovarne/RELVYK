import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceStore } from '../src/evidence-store.js';

const clone = (value) => value === undefined ? undefined : structuredClone(value);

/** A minimal asynchronous IndexedDB test double, with state shared across reopened connections. */
function mockIndexedDB({ quotaFailure = false } = {}) {
  const collections = new Map();
  let created = false;
  const db = {
    objectStoreNames: { contains: (name) => collections.has(name) },
    createObjectStore(name, { keyPath }) { collections.set(name, { keyPath, values: new Map() }); },
    close() {},
    transaction(name) {
      const transaction = { error: null };
      transaction.objectStore = () => {
        const { keyPath, values } = collections.get(name);
        const schedule = (operation, fail = false) => {
          const request = {};
          queueMicrotask(() => {
            if (fail) {
              request.error = transaction.error = new Error('Mock quota exceeded');
              request.onerror?.();
              queueMicrotask(() => transaction.onabort?.());
              return;
            }
            request.result = operation();
            request.onsuccess?.();
            queueMicrotask(() => transaction.oncomplete?.());
          });
          return request;
        };
        return {
          put: (value) => schedule(() => { values.set(value[keyPath], clone(value)); return value[keyPath]; }, quotaFailure),
          get: (key) => schedule(() => clone(values.get(key))),
          getAll: () => schedule(() => [...values.values()].map(clone)),
          delete: (key) => schedule(() => values.delete(key)),
        };
      };
      return transaction;
    },
  };
  return { open() { const request = { result: db }; queueMicrotask(() => { if (!created) { created = true; request.onupgradeneeded?.(); } request.onsuccess?.(); }); return request; } };
}

test('unavailable browser persistence is reported as memory and never claimed as saved locally', async () => {
  const store = createEvidenceStore({ indexedDB: null });
  await store.ready;
  assert.equal(store.status.persistent, false);
  assert.equal(store.status.storageScope, 'memory');
  assert.match(store.status.message, /lost when it closes/);
  const record = await store.saveRecord({ runId: 'mock-run', taskType: 'token', input: 'mock', network: 'devnet', completedAt: '2026-10-14T01:00:00.000Z', checks: [], result: { amount: '18446744073709551615' } });
  assert.equal(record.storageScope, 'memory');
  assert.equal(JSON.parse(await store.exportRecord(record.runId)).result.amount, '18446744073709551615');
  const second = createEvidenceStore({ indexedDB: null });
  assert.equal(await second.getRecord(record.runId), null);
});

test('IndexedDB records restore across store instances, with safe independent copies and exact amounts', async () => {
  const indexedDB = mockIndexedDB();
  const first = createEvidenceStore({ indexedDB, name: 'mock-restore' });
  await first.ready;
  const input = { runId: 'mock-persistent', taskType: 'token', network: 'devnet', completedAt: '2026-10-14T01:00:00.000Z', result: { supply: '18446744073709551615', metadata: '<script>not executable</script>' } };
  const saved = await first.saveRecord(input);
  input.result.supply = '0';
  saved.result.metadata = 'changed externally';
  assert.equal(first.status.persistent, true);
  assert.equal(saved.storageScope, 'local');
  first.close();
  const second = createEvidenceStore({ indexedDB, name: 'mock-restore' });
  const restored = await second.getRecord('mock-persistent');
  assert.equal(restored.result.supply, '18446744073709551615');
  assert.equal(restored.result.metadata, '<script>not executable</script>');
  assert.equal((await second.listRecords({ type: 'token', network: 'devnet' })).length, 1);
  assert.equal((await second.listRecords({ network: 'testnet' })).length, 0);
  await second.deleteRecord('mock-persistent');
  assert.equal(await second.getRecord('mock-persistent'), null);
  await assert.rejects(second.exportRecord('mock-persistent'), /no longer available/);
});

test('a runtime quota failure keeps the current result in explicitly labeled memory', async () => {
  const store = createEvidenceStore({ indexedDB: mockIndexedDB({ quotaFailure: true }) });
  await store.ready;
  assert.equal(store.status.storageScope, 'local');
  const record = await store.saveRecord({ runId: 'mock-quota', taskType: 'transaction', completedAt: '2026-10-14T01:00:00.000Z' });
  assert.equal(record.storageScope, 'memory');
  assert.equal(store.status.persistent, false);
  assert.equal((await store.getRecord(record.runId)).runId, record.runId);
});

test('network and owner boundaries select only the matching saved snapshots', async () => {
  const store = createEvidenceStore({ indexedDB: null });
  await store.saveSnapshot({ snapshotId: 'mock-one', network: 'devnet', owner: 'owner-a', observedAt: '2026-10-14T01:00:00.000Z' });
  await store.saveSnapshot({ snapshotId: 'mock-two', network: 'devnet', owner: 'owner-a', observedAt: '2026-10-14T02:00:00.000Z' });
  await store.saveSnapshot({ snapshotId: 'mock-other', network: 'mainnet-beta', owner: 'owner-a', observedAt: '2026-10-14T03:00:00.000Z' });
  const items = await store.listSnapshots({ network: 'devnet', owner: 'owner-a', limit: 1 });
  assert.equal(items[0].snapshotId, 'mock-two');
  await assert.rejects(store.saveRecord({ id: 'wrong-key' }), /runId/);
  await assert.rejects(store.list('unknown'), /Unknown evidence collection/);
});

test('deleting a capture record removes its snapshot without deleting another capture', async () => {
  const store = createEvidenceStore({ indexedDB: null });
  await store.saveSnapshot({ snapshotId: 'mock-capture', owner: 'owner-a', network: 'devnet', observedAt: '2026-10-14T01:00:00.000Z' });
  await store.saveSnapshot({ snapshotId: 'mock-other-capture', owner: 'owner-a', network: 'devnet', observedAt: '2026-10-14T02:00:00.000Z' });
  await store.saveRecord({ runId: 'mock-capture-record', taskType: 'snapshot', result: { snapshotId: 'mock-capture' } });
  await store.deleteRecord('mock-capture-record');
  assert.equal(await store.getRecord('mock-capture-record'), null);
  assert.equal(await store.getSnapshot('mock-capture'), null);
  assert.ok(await store.getSnapshot('mock-other-capture'));
});
