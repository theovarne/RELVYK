import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskEngine, TASK_STAGES } from '../src/task-engine.js';
import { createEvidenceStore } from '../src/evidence-store.js';
import { createReflexLibrary, defaultTemplateFor } from '../src/reflex-library.js';
import { compareSnapshots } from '../src/solana/snapshot.js';

// These are mock inputs and source responses. They are not claimed to be chain observations.
const signature = '1'.repeat(64);
const otherSignature = '1'.repeat(63) + '2';
const address = '1'.repeat(32);
const secondAddress = '1'.repeat(31) + '2';
const memoryStore = () => createEvidenceStore({ indexedDB: null });
const check = (id, status = 'pass') => ({ id, label: id, status, finding: `Mock ${id}`, evidence: ['raw.mock'] });
function observation(kind = 'transaction', extra = {}) {
  return {
    kind, summary: { taskStatus: 'completed', network: 'devnet', input: signature, chainStatus: 'successful', finality: 'confirmed', ...extra },
    checks: [check('returned')], raw: { mock: true }, evidenceRefs: [{ path: 'raw.mock' }],
    observedAt: '2026-10-14T01:00:00.000Z', dataSource: 'Mock RPC source',
  };
}
function services(overrides = {}) {
  return { inspectTransaction: async () => observation(), inspectToken: async () => observation('token'), createSnapshot: async () => observation('snapshot'), ...overrides };
}

test('one state drives all six stages and a failed chain transaction remains a completed analysis', async () => {
  const store = memoryStore();
  const stages = [];
  const engine = createTaskEngine({ store, services: services({ inspectTransaction: async () => observation('transaction', { chainStatus: 'failed', error: { InstructionError: [0, 'Custom'] } }) }) });
  engine.subscribe((state) => { if (state.stepRecords.at(-1)?.status === 'running' && stages.at(-1) !== state.stage) stages.push(state.stage); });
  const record = await engine.run({ type: 'transaction', input: signature, network: 'devnet' });
  assert.deepEqual(stages, [...TASK_STAGES]);
  assert.equal(engine.getState().status, 'complete');
  assert.equal(record.outcome, 'completed');
  assert.equal(record.chainExecution.status, 'failed');
  assert.equal(record.chainExecution.initiatedByApplication, false);
  assert.equal(record.chainExecution.finality, 'confirmed');
  assert.equal(record.storageScope, 'memory');
  assert.equal(record.stepRecords.length, 6);
  assert.ok(record.stepRecords.every((step) => step.status === 'complete' && step.startedAt.endsWith('Z') && step.completedAt.endsWith('Z')));
  assert.equal((await store.getRecord(record.runId)).input, signature);
  engine.destroy();
});

test('invalid inputs stop before a real read and do not create fake execution records', async () => {
  let reads = 0;
  const store = memoryStore();
  const engine = createTaskEngine({ store, services: services({ inspectTransaction: async () => { reads += 1; return observation(); } }) });
  assert.equal(await engine.run({ type: 'transaction', input: 'not a signature', network: 'devnet' }), null);
  assert.equal(reads, 0);
  assert.equal(engine.getState().error.code, 'INVALID_INPUT');
  assert.equal(engine.getState().task.input, 'not a signature');
  assert.deepEqual(await store.listRecords(), []);
  engine.destroy();
});

test('a cancelled stale read cannot overwrite or save over the next input', async () => {
  let resolveFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const firstResponse = new Promise((resolve) => { resolveFirst = resolve; });
  const store = memoryStore();
  const engine = createTaskEngine({ store, services: services({ inspectTransaction: async (input) => { if (input === signature) { firstStarted(); return firstResponse; } return observation('transaction', { input }); } }) });
  const firstRun = engine.run({ type: 'transaction', input: signature, network: 'devnet' });
  await started;
  const secondRun = await engine.run({ type: 'transaction', input: otherSignature, network: 'devnet' });
  resolveFirst(observation());
  assert.equal(await firstRun, null);
  assert.equal(engine.getState().record.runId, secondRun.runId);
  assert.equal(engine.getState().result.summary.input, otherSignature);
  const records = await store.listRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].input, otherSignature);
  engine.destroy();
});

test('a timeout records unknown checks and a failed read without a green result', async () => {
  const store = memoryStore();
  const engine = createTaskEngine({ store, services: services({ inspectTransaction: async () => { throw Object.assign(new Error('Mock source read timed out.'), { code: 'RPC_TIMEOUT', retryable: true }); } }) });
  const record = await engine.run({ type: 'transaction', input: signature, network: 'devnet' });
  assert.equal(engine.getState().status, 'error');
  assert.equal(record.outcome, 'error');
  assert.equal(record.observedAt, null);
  assert.equal(record.result, null);
  assert.equal(record.stepRecords.find((step) => step.stage === 'EXECUTE').status, 'failed');
  assert.equal(record.checks[0].status, 'unknown');
  assert.equal(record.error.retryable, true);
  assert.equal(record.stepRecords.at(-1).stage, 'REMEMBER');
  engine.destroy();
});

test('saved replay preserves observation timestamps and never queries or increments execution counts', async () => {
  let reads = 0;
  const store = memoryStore();
  const engine = createTaskEngine({ store, services: services({ inspectTransaction: async () => { reads += 1; return observation(); } }) });
  const library = createReflexLibrary({ store, engine });
  const record = await library.run('inspect-transaction', { input: signature, network: 'devnet' });
  const replayedStages = [];
  await engine.replay(record.runId, { onStep: (step) => replayedStages.push(step.stage) });
  assert.deepEqual(replayedStages, [...TASK_STAGES]);
  assert.equal(engine.getState().mode, 'replay');
  assert.equal(engine.getState().observedAt, record.observedAt);
  assert.equal(engine.getState().completedAt, record.completedAt);
  assert.equal(reads, 1);
  assert.equal((await store.listRecords()).length, 1);
  assert.equal((await library.get('inspect-transaction')).executionCount, 1);
  engine.destroy();
});

test('snapshots compare the two actual observations of the same owner and network only', async () => {
  let reads = 0;
  let comparisons = 0;
  const store = memoryStore();
  const engine = createTaskEngine({ store, services: services({
    createSnapshot: async (owner, network) => {
      reads += 1;
      const result = observation('snapshot', { owner, network, input: owner, slot: reads, balances: [{ mint: secondAddress, program: 'mock-token-program', amount: String(reads * 10), decimals: 2 }] });
      result.observedAt = `2026-10-14T01:00:0${reads}.000Z`;
      return result;
    },
    compareSnapshots: (saved, captured) => {
      comparisons += 1;
      const previous = saved.summary || saved, current = captured.summary || captured;
      assert.equal(previous.owner, current.owner);
      assert.equal(previous.network, current.network);
      return { kind: 'comparison', summary: { from: previous.slot, to: current.slot, delta: (BigInt(current.balances[0].amount) - BigInt(previous.balances[0].amount)).toString() }, checks: [check('same-owner')] };
    },
  }) });
  const baseline = await engine.run({ type: 'snapshot', input: address, network: 'devnet' });
  assert.equal(baseline.result.comparison, null);
  assert.equal(baseline.result.comparisonStatus, 'baseline-created');
  const comparison = await engine.run({ type: 'snapshot', input: address, network: 'devnet' });
  assert.deepEqual(comparison.result.comparison.summary, { from: 1, to: 2, delta: '10' });
  await engine.run({ type: 'snapshot', input: address, network: 'testnet' });
  await engine.run({ type: 'snapshot', input: secondAddress, network: 'devnet' });
  assert.equal(comparisons, 1);
  assert.equal((await store.listSnapshots({ owner: address, network: 'devnet' })).length, 2);
  assert.equal((await store.listSnapshots()).length, 4);
  engine.destroy();
});

test('a saved parameter copy executes the supported path and keeps independent version statistics', async () => {
  const store = memoryStore();
  const engine = createTaskEngine({ store, services: services() });
  const library = createReflexLibrary({ store, engine });
  assert.equal((await library.list()).length, 3);
  const item = await library.saveCopy('inspect-transaction', { title: '<script>untrusted title</script>', input: signature, network: 'devnet' });
  assert.equal(item.sourceId, 'inspect-transaction');
  assert.equal((await library.get(item.id)).executionCount, 0);
  const record = await library.run(item.id);
  assert.equal(record.input, signature);
  assert.equal(record.templateId, item.id);
  assert.equal((await library.get(item.id)).executionCount, 1);
  assert.equal((await library.get('inspect-transaction')).executionCount, 0);
  await store.saveReflex({ ...item, version: '2.0.0' });
  assert.equal((await library.get(item.id)).executionCount, 0);
  assert.equal((await library.list({ search: 'untrusted', type: 'transaction' })).length, 1);
  engine.destroy();
});

test('an unknown template version cannot execute reads or inherit a successful result', async () => {
  let reads = 0;
  const store = memoryStore();
  const engine = createTaskEngine({ store, services: services({ inspectTransaction: async () => { reads += 1; return observation(); } }) });
  const record = await engine.run({ type: 'transaction', input: signature, network: 'devnet', templateVersion: '9.9.9' });
  assert.equal(record, null);
  assert.equal(reads, 0);
  assert.equal(engine.getState().error.code, 'INVALID_TEMPLATE');
  assert.equal((await store.listRecords()).length, 0);
  engine.destroy();
});

test('a partial snapshot is retained as partial and does not disappear from comparison evidence', async () => {
  let comparisons = 0;
  const store = memoryStore();
  const engine = createTaskEngine({ store, services: services({
    createSnapshot: async (owner, network) => observation('snapshot', { owner, network, input: owner, taskStatus: 'incomplete', complete: false, balances: [], slot: null }),
    compareSnapshots: (saved, captured) => { comparisons += 1; assert.equal(saved.summary.complete, false); assert.equal(captured.summary.complete, false); return { kind: 'comparison', summary: { complete: false }, checks: [check('snapshot-scope', 'unknown')] }; },
  }) });
  const first = await engine.run({ type: 'snapshot', input: address, network: 'devnet' });
  assert.equal(first.outcome, 'incomplete');
  assert.ok(first.result.snapshotId);
  const second = await engine.run({ type: 'snapshot', input: address, network: 'devnet' });
  assert.equal(comparisons, 1);
  assert.equal(second.result.comparison.summary.complete, false);
  assert.equal(second.checks.at(-1).status, 'unknown');
  assert.equal((await store.listSnapshots()).length, 2);
  engine.destroy();
});

test('cached source reads retain source time and are distinguished from new observations', async () => {
  const store = memoryStore();
  const cached = { ...observation(), cached: true, cacheAgeMs: 1500 };
  const engine = createTaskEngine({ store, services: services({ inspectTransaction: async () => cached }) });
  const record = await engine.run({ type: 'transaction', input: signature, network: 'devnet' });
  assert.equal(record.observationKind, 'cached-query');
  assert.equal(record.observedAt, cached.observedAt);
  assert.deepEqual(record.cache, { reused: true, ageMs: 1500 });
  engine.destroy();
});

test('transaction rules 1.1.0 do not inherit run counts or evidence from version 1.0.0', async () => {
  let reads = 0;
  const store = memoryStore();
  const engine = createTaskEngine({ store, services: services({ inspectTransaction: async () => { reads += 1; return observation(); } }) });
  const library = createReflexLibrary({ store, engine });
  const legacy = await store.saveRecord({ runId: 'old-version-mock', taskType: 'transaction', templateId: 'inspect-transaction', templateVersion: '1.0.0', mode: 'query', executed: true, outcome: 'completed', completedAt: '2026-10-14T01:00:00.000Z', stepRecords: [], checks: [check('returned')], result: observation() });
  const current = await library.get('inspect-transaction');
  assert.equal(current.version, '1.1.0');
  assert.equal(current.ruleVersion, '1.1.0');
  assert.equal(current.executionCount, 0);
  assert.equal(current.lastVerifiedAt, null);
  assert.deepEqual(current.evidenceRefs, []);
  assert.match(current.checks.find(item => item.id === 'transaction-config').scope, /total in lamports/);
  assert.equal((await library.get('inspect-mint-controls')).version, '1.0.0');
  assert.equal((await library.get('compare-account-snapshots')).version, '1.0.0');
  const fresh = await library.run('inspect-transaction', { input: signature, network: 'devnet' });
  assert.equal(fresh.templateVersion, '1.1.0');
  assert.equal(fresh.ruleVersion, '1.1.0');
  assert.equal((await library.get('inspect-transaction')).executionCount, 1);
  assert.deepEqual((await library.recentRecords('inspect-transaction')).map(record => record.runId), [fresh.runId]);
  await engine.replay(legacy);
  assert.equal(reads, 1);
  assert.equal((await library.get('inspect-transaction')).executionCount, 1);
  engine.destroy();
});

test('old parameter copies cannot silently execute newer rules; nested new copies retain the code-check version', async () => {
  const store = memoryStore();
  const engine = createTaskEngine({ store, services: services() });
  const library = createReflexLibrary({ store, engine });
  await store.saveReflex({ ...defaultTemplateFor('transaction'), id: 'old-parameter-mock', ruleVersion: undefined, version: '1.0.0', sourceId: 'inspect-transaction', sourceVersion: '1.0.0', parameters: { input: signature, network: 'devnet' } });
  assert.equal(await library.run('old-parameter-mock'), null);
  assert.equal(engine.getState().error.code, 'INVALID_TEMPLATE');
  assert.match(engine.getState().error.message, /older checks/);
  await assert.rejects(library.saveCopy('old-parameter-mock', { input: signature, network: 'devnet' }), /older check version/);
  const first = await library.saveCopy('inspect-transaction', { input: signature, network: 'devnet' });
  const nested = await library.saveCopy(first.id, { input: otherSignature, network: 'devnet' });
  assert.equal(first.version, '1.0.0');
  assert.equal(first.ruleVersion, '1.1.0');
  assert.equal(nested.sourceVersion, '1.0.0');
  assert.equal(nested.ruleVersion, '1.1.0');
  const record = await library.run(nested.id);
  assert.equal(record.ruleVersion, '1.1.0');
  assert.equal(record.templateVersion, '1.0.0');
  assert.equal(record.input, otherSignature);
  engine.destroy();
});

test('an invalid provider envelope is not retained as usable evidence after response validation fails', async () => {
  const store = memoryStore();
  const engine = createTaskEngine({ store, services: services({ inspectTransaction: async () => ({ observedAt: 'not a timestamp', summary: { taskStatus: 'completed' }, checks: [] }) }) });
  const record = await engine.run({ type: 'transaction', input: signature, network: 'devnet' });
  assert.equal(record.outcome, 'error');
  assert.equal(record.result, null);
  assert.equal(record.checks[0].status, 'unknown');
  assert.equal(record.error.code, 'INVALID_RESPONSE');
  assert.equal(engine.getState().result, null);
  engine.destroy();
});

test('an incomplete transaction read remains incomplete without becoming a failed analysis', async () => {
  const store = memoryStore();
  const value = observation('transaction', { taskStatus: 'incomplete', chainStatus: 'unknown', slot: null });
  value.checks = [check('transaction-available', 'unknown')];
  const engine = createTaskEngine({ store, services: services({ inspectTransaction: async () => value }) });
  const record = await engine.run({ type: 'transaction', input: signature, network: 'devnet' });
  assert.equal(record.outcome, 'incomplete');
  assert.equal(engine.getState().status, 'complete');
  assert.equal(record.chainExecution.status, 'unknown');
  assert.equal(record.checks[0].status, 'unknown');
  assert.equal(record.error, null);
  engine.destroy();
});

test('snapshot comparisons retain both captures source references without recursively copying prior comparison refs', async () => {
  let reads = 0;
  const store = memoryStore();
  const engine = createTaskEngine({ store, services: services({
    createSnapshot: async (owner, network) => {
      reads += 1;
      const timestamp = `2026-10-14T01:00:0${reads}.000Z`;
      return { ...observation('snapshot', { owner, network, input: owner, observedAt: timestamp, complete: true, solLamports: String(reads * 10), balances: [], slot: String(reads) }), observedAt: timestamp, cached: reads === 1, cacheAgeMs: reads === 1 ? 1200 : 0, evidenceRefs: [{ id: `mock-capture-${reads}`, method: 'getBalance', observedAt: timestamp, cached: reads === 1, cacheAgeMs: reads === 1 ? 1200 : 0 }] };
    },
    compareSnapshots,
  }) });
  await engine.run({ type: 'snapshot', input: address, network: 'devnet' });
  const second = await engine.run({ type: 'snapshot', input: address, network: 'devnet' });
  assert.equal(second.result.comparison.evidenceRefs.length, 2);
  assert.equal(second.result.comparison.evidenceRefs[0].cached, true);
  assert.equal(second.result.comparison.evidenceRefs[0].observedAt, '2026-10-14T01:00:01.000Z');
  assert.equal(second.result.comparison.evidenceRefs[1].cached, false);
  const third = await engine.run({ type: 'snapshot', input: address, network: 'devnet' });
  assert.equal(third.result.comparison.evidenceRefs.length, 2);
  assert.ok(third.result.comparison.evidenceRefs.every(ref => ref.kind !== 'local-snapshot'));
  const saved = await store.getSnapshot(third.result.snapshotId);
  assert.equal(saved.evidenceRefs.length, 1);
  assert.equal(saved.capturedByRunId, third.runId);
  assert.ok(saved.savedAt.endsWith('Z'));
  engine.destroy();
});

test('an older cached capture is never relabeled as the first baseline or compared against a conveniently older snapshot', async () => {
  let comparisons = 0;
  const store = memoryStore();
  for (const [index, time] of ['2026-10-14T01:00:00.000Z', '2026-10-14T01:03:00.000Z'].entries()) {
    await store.saveSnapshot({ snapshotId: `existing-mock-${index}`, owner: address, network: 'devnet', observedAt: time, savedAt: `2026-10-14T12:00:0${index}.000Z`, summary: { owner: address, network: 'devnet', observedAt: time, complete: true, solLamports: '10', balances: [] }, evidenceRefs: [] });
  }
  const cached = { ...observation('snapshot', { owner: address, network: 'devnet', input: address, observedAt: '2026-10-14T01:02:00.000Z', complete: true, solLamports: '10', balances: [] }), observedAt: '2026-10-14T01:02:00.000Z', cached: true, cacheAgeMs: 1000 };
  const engine = createTaskEngine({ store, services: services({ createSnapshot: async () => cached, compareSnapshots: (...args) => { comparisons += 1; return compareSnapshots(...args); } }) });
  const record = await engine.run({ type: 'snapshot', input: address, network: 'devnet' });
  assert.equal(comparisons, 0);
  assert.equal(record.result.comparison, null);
  assert.equal(record.result.comparisonStatus, 'comparison-unavailable');
  assert.match(record.result.comparisonReason, /predates the latest saved capture/);
  assert.equal(record.checks.at(-1).status, 'unknown');
  assert.ok(record.result.snapshotId);
  assert.equal((await store.listSnapshots()).length, 3);
  engine.destroy();
});

test('an unusable local baseline does not discard a successful source capture or fabricate comparison output', async () => {
  const store = memoryStore();
  await store.saveSnapshot({ snapshotId: 'bad-local-mock', owner: address, network: 'devnet', observedAt: '2026-10-14T01:00:00.000Z', summary: { owner: secondAddress, network: 'devnet', observedAt: '2026-10-14T01:00:00.000Z', balances: [] } });
  const capture = observation('snapshot', { owner: address, network: 'devnet', input: address, observedAt: '2026-10-14T01:00:00.000Z', complete: true, solLamports: '10', balances: [] });
  const engine = createTaskEngine({ store, services: services({ createSnapshot: async () => capture, compareSnapshots }) });
  const record = await engine.run({ type: 'snapshot', input: address, network: 'devnet' });
  assert.equal(record.error, null);
  assert.equal(record.result.summary.owner, address);
  assert.equal(record.result.comparison, null);
  assert.equal(record.result.comparisonStatus, 'comparison-unavailable');
  assert.equal(record.checks.at(-1).status, 'unknown');
  assert.ok(await store.getSnapshot(record.result.snapshotId));
  engine.destroy();
});
