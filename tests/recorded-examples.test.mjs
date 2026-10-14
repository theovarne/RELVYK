import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getRecordedExamples, loadRecordedExample } from '../src/recorded-examples.js';
import { createReplayController } from '../src/replay-controller.js';
import { createTaskEngine } from '../src/task-engine.js';
import { createEvidenceStore } from '../src/evidence-store.js';

// These packaged cases are genuine earlier public RPC captures. Replaying them
// here is an offline historical replay, not a new chain or wallet verification.
const localFetch = async url => ({ ok: true, json: async () => JSON.parse(await readFile(url, 'utf8')) });

test('packaged examples preserve real source evidence and isolate their identities from browser records', async () => {
  const catalogue = getRecordedExamples();
  assert.equal(catalogue.length, 2);
  for (const example of catalogue) {
    const loaded = await loadRecordedExample(example.id, { fetchImpl: localFetch });
    const source = JSON.parse(await readFile(new URL(`../${example.sourceRecord}`, import.meta.url), 'utf8'));
    assert.equal(loaded.recordKind, 'RecordedExample');
    assert.equal(loaded.runId, `example:${example.id}`);
    assert.equal(loaded.exampleSource.originalRunId, source.runId);
    assert.equal(loaded.observationKind, 'recorded-example');
    assert.deepEqual(loaded.result.raw, source.result.raw);
    assert.deepEqual(loaded.stepRecords, source.stepRecords);
    assert.equal(loaded.observedAt, source.observedAt);
    assert.equal(loaded.input, source.input);
  }
  const failed = await loadRecordedExample('mainnet-failed-v1', { fetchImpl: localFetch });
  assert.equal(failed.result.summary.version, 1);
  assert.equal(failed.chainExecution.status, 'failed');
  assert.equal(failed.outcome, 'completed');
});

test('real engine replays packaged evidence without source reads, saved records, or template counts', async () => {
  const store = createEvidenceStore({ indexedDB: null });
  let reads = 0;
  const engine = createTaskEngine({ store, services: { inspectTransaction: async () => { reads++; throw new Error('Replay must not query RPC'); } } });
  const controller = createReplayController({ engine });
  for (const example of getRecordedExamples()) {
    const loaded = await loadRecordedExample(example.id, { fetchImpl: localFetch });
    await controller.load(loaded); controller.seek(4); controller.step(1); controller.pause();
    assert.equal(controller.getState().label, 'Recorded Example / Replay');
    assert.equal(controller.getState().presentation.result.summary.input, loaded.input);
  }
  assert.equal(reads, 0);
  assert.deepEqual(await store.listRecords(), []);
  assert.deepEqual(await store.listReflexes(), []);
  controller.destroy(); engine.destroy();
});

test('example loader rejects arbitrary URLs and reports missing local assets', async () => {
  let requests = 0;
  await assert.rejects(loadRecordedExample('https://example.com/injected.json', { fetchImpl: async () => { requests++; } }), /catalogue/);
  assert.equal(requests, 0);
  await assert.rejects(loadRecordedExample('devnet-transaction', { fetchImpl: async () => ({ ok: false }) }), /could not be loaded/);
});
