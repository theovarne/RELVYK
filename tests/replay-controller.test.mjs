import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplayController } from '../src/replay-controller.js';

const STAGES = ['SENSE', 'PLAN', 'AUTHORIZE', 'EXECUTE', 'VERIFY', 'REMEMBER'];
function record() {
  return { runId: 'recorded-test', taskType: 'transaction', network: 'devnet', input: '1'.repeat(64),
    startedAt: '2026-10-14T00:00:00.000Z', completedAt: '2026-10-14T00:00:01.000Z',
    observedAt: '2026-10-14T00:00:00.500Z', checks: [], result: { summary: { taskStatus: 'completed' } },
    stepRecords: STAGES.map(stage => ({ stage, status: 'complete', summary: `Recorded ${stage}`,
      startedAt: '2026-10-14T00:00:00.000Z', completedAt: '2026-10-14T00:00:01.000Z' })) };
}
function mockEngine() {
  let state = { mode: 'query', status: 'idle', runId: null };
  const listeners = new Set();
  let replayCount = 0;
  function publish(next) { state = next; for (const listener of listeners) listener(state); }
  return { getState: () => structuredClone(state), get replayCount() { return replayCount; },
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    async replay(value) { replayCount++; publish({ ...value, mode: 'replay', status: 'complete', record: value }); return value; },
    userQuery() { publish({ mode: 'query', status: 'running', runId: 'new-live-query' }); },
    run() { throw new Error('Playback must never run a query'); },
  };
}
function timers() {
  const tasks = new Map();
  let next = 0;
  return { setTimer(fn, delay) { const id = ++next; tasks.set(id, { fn, delay }); return id; },
    clearTimer(id) { tasks.delete(id); },
    tick() { const [id, task] = tasks.entries().next().value || []; if (task) { tasks.delete(id); task.fn(); } },
    get count() { return tasks.size; }, get delay() { return tasks.values().next().value?.delay; } };
}

test('mock replay: one hydration followed by pause, seek and paced step playback without another query', async () => {
  const engine = mockEngine(); const clock = timers(); const selected = [];
  const controller = createReplayController({ engine, ...clock, onSelectStep: (step, index, view) => selected.push({ step, index, view }) });
  await controller.load(record());
  assert.equal(controller.getState().status, 'paused');
  assert.equal(controller.getState().step.stage, 'SENSE');
  controller.play(); clock.tick();
  assert.equal(controller.getState().step.stage, 'PLAN');
  controller.pause(); assert.equal(clock.count, 0);
  controller.seek(4); assert.equal(controller.getState().step.stage, 'VERIFY');
  controller.step(-1); assert.equal(controller.getState().step.stage, 'EXECUTE');
  controller.step(1); controller.play(); clock.tick();
  assert.equal(controller.getState().status, 'ended');
  assert.equal(controller.getState().step.stage, 'REMEMBER');
  assert.equal(engine.replayCount, 1);
  assert.equal(selected.at(-1).view.mode, 'replay');
  assert.equal(selected.at(-1).view.status, 'replay');
  assert.equal(selected.at(-1).view.stepRecords.length, 6);
  controller.destroy();
});

test('mock replay: original timestamps remain unchanged and speed is explicitly reading pace', async () => {
  const engine = mockEngine(); const clock = timers(); const source = record(); const original = JSON.stringify(source);
  const controller = createReplayController({ engine, ...clock, stepIntervalMs: 1400 });
  await controller.load(source); controller.seek(3); controller.setSpeed(2); controller.play();
  assert.equal(clock.delay, 700);
  assert.match(controller.getState().pacing, /not recorded elapsed time/);
  assert.equal(controller.getState().presentation.startedAt, source.startedAt);
  assert.equal(controller.getState().presentation.completedAt, source.completedAt);
  clock.tick(); controller.pause();
  assert.equal(JSON.stringify(source), original);
  assert.equal(controller.getState().label, 'Recorded Run / Replay');
  controller.destroy();
});

test('mock replay: a new user query stops playback and cannot be overwritten by its timer', async () => {
  const engine = mockEngine(); const clock = timers(); const selected = [];
  const controller = createReplayController({ engine, ...clock, onSelectStep: step => selected.push(step.stage) });
  await controller.load(record()); controller.play();
  engine.userQuery();
  assert.equal(clock.count, 0);
  assert.equal(controller.getState().status, 'stopped');
  assert.equal(controller.getState().presentation, null);
  clock.tick(); assert.deepEqual(selected, ['SENSE']);
  controller.destroy();
});

test('mock replay: seek is bounded and malformed stages are rejected', async () => {
  const engine = mockEngine(); const controller = createReplayController({ engine, ...timers() });
  await assert.rejects(controller.load({ ...record(), stepRecords: [{ stage: 'invented-stage' }] }), /recognized processing steps/);
  await controller.load(record()); controller.seek(900); assert.equal(controller.getState().selectedStep, 5);
  controller.seek(-10); assert.equal(controller.getState().selectedStep, 0);
  assert.throws(() => controller.setSpeed(12), /playback pace/);
  controller.destroy();
});
