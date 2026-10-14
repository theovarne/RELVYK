const STAGES = ['SENSE', 'PLAN', 'AUTHORIZE', 'EXECUTE', 'VERIFY', 'REMEMBER'];
const copy = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));

/**
 * @typedef {{runId?:string|null,mode?:string,status?:string} & Record<string,any>} ReplayEngineState
 * @typedef {{getState:()=>ReplayEngineState,replay:(record:any)=>Promise<any>,subscribe:(listener:(state:ReplayEngineState)=>void)=>()=>void}} ReplayEngine
 * @typedef {{engine:ReplayEngine,onSelectStep?:(step:any,index:number,presentation:any)=>void,onChange?:(state:any)=>void,
 * stepIntervalMs?:number,setTimer?:typeof setTimeout,clearTimer?:typeof clearTimeout}} ReplayOptions
 */

/**
 * Recorded stage playback only. The optional speed changes reading pace, not
 * historical durations. The original record and its timestamps are never edited.
 * @param {ReplayOptions} options
 */
export function createReplayController({ engine, onSelectStep, onChange, stepIntervalMs = 1400,
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout }) {
  if (typeof engine?.replay !== 'function' || typeof engine.getState !== 'function' || typeof engine.subscribe !== 'function') {
    throw new TypeError('A task engine with recorded replay is required.');
  }
  const listeners = new Set();
  if (typeof onChange === 'function') listeners.add(onChange);
  let record = null;
  let selected = -1;
  let status = 'empty';
  let speed = 1;
  let timer = null;
  let generation = 0;
  let destroyed = false;
  let sawOwnReplay = false;

  function clearPlayback() { if (timer !== null) clearTimer(timer); timer = null; }
  function presentation() {
    if (!record || selected < 0 || ['empty', 'loading', 'stopped'].includes(status)) return null;
    return { ...copy(engine.getState()), status: 'replay', mode: 'replay', stage: record.stepRecords[selected].stage,
      runId: record.runId, record: copy(record), stepRecords: copy(record.stepRecords.slice(0, selected + 1)),
      checks: copy(record.checks || []), result: copy(record.result || null),
      observedAt: record.observedAt || null, startedAt: record.startedAt || null, completedAt: record.completedAt || null,
      dataSource: copy(record.dataSource || null), task: { type: record.taskType, input: record.input, network: record.network },
      replayPresentation: { selectedStep: selected, stepCount: record.stepRecords.length, pacing: 'step-based', source: record.recordKind === 'RecordedExample' ? 'Recorded Example' : 'Recorded Run' } };
  }

  function getState() {
    return { status, playing: status === 'playing', active: ['paused', 'playing', 'ended'].includes(status),
      selectedStep: selected, stepCount: record?.stepRecords.length || 0,
      step: selected >= 0 && record ? copy(record.stepRecords[selected]) : null,
      record: record ? copy(record) : null, speed,
      label: record?.recordKind === 'RecordedExample' ? 'Recorded Example / Replay' : 'Recorded Run / Replay',
      pacing: 'Step playback; speed controls reading pace, not recorded elapsed time.',
      presentation: presentation() };
  }
  function emit(selection = false) {
    if (destroyed) return;
    const state = getState();
    if (selection && state.presentation && typeof onSelectStep === 'function') {
      try { onSelectStep(state.step, selected, state.presentation); } catch { /* Keep replay controls available if a view fails. */ }
    }
    for (const listener of listeners) { try { listener(state); } catch { /* A view cannot alter the recorded data. */ } }
  }
  function pause() {
    clearPlayback();
    if (status === 'playing') { status = 'paused'; emit(); }
    return getState();
  }
  function stop() {
    ++generation;
    clearPlayback();
    if (record) { status = 'stopped'; emit(); }
    return getState();
  }
  function schedule() {
    clearPlayback();
    if (status !== 'playing' || destroyed) return;
    const token = generation;
    const pace = Math.min(10_000, Math.max(250, stepIntervalMs)) / speed;
    timer = setTimer(() => {
      timer = null;
      if (destroyed || token !== generation || status !== 'playing') return;
      if (selected < record.stepRecords.length - 1) {
        selected++;
        if (selected === record.stepRecords.length - 1) status = 'ended';
        emit(true);
        schedule();
      } else { status = 'ended'; emit(); }
    }, pace);
  }

  async function load(nextRecord) {
    if (destroyed) throw new Error('Replay controller has been disposed.');
    if (!nextRecord?.runId || !Array.isArray(nextRecord.stepRecords) || !nextRecord.stepRecords.length
      || nextRecord.stepRecords.some(step => !STAGES.includes(step?.stage))) {
      throw new TypeError('A recorded run with recognized processing steps is required.');
    }
    const token = ++generation;
    clearPlayback();
    record = copy(nextRecord); selected = -1; status = 'loading'; sawOwnReplay = false;
    emit();
    try {
      // Existing immediate replay hydrates evidence once. Playback below changes
      // only the presentation cursor and never asks the engine to run a new task.
      const loaded = await engine.replay(copy(record));
      if (token !== generation || destroyed) return getState();
      if (!loaded) { status = 'stopped'; emit(); return getState(); }
      selected = 0; status = 'paused'; emit(true);
    } catch (error) {
      if (token === generation && !destroyed) { status = 'stopped'; emit(); }
      throw error;
    }
    return getState();
  }

  function seek(index) {
    if (!record || !['paused', 'playing', 'ended'].includes(status) || !Number.isFinite(index)) return getState();
    pause();
    selected = Math.max(0, Math.min(record.stepRecords.length - 1, Math.round(index)));
    status = 'paused'; emit(true);
    return getState();
  }
  const unsubscribe = engine.subscribe(state => {
    if (!record || destroyed || ['empty', 'stopped'].includes(status)) return;
    if (state.mode === 'replay' && state.runId === record.runId) { sawOwnReplay = true; return; }
    // Ignore the existing engine's synchronous cancellation notification before
    // it enters this replay; later user tasks immediately stop this presentation.
    if (status === 'loading' && !sawOwnReplay) return;
    if (state.mode !== 'replay' || state.runId !== record.runId) stop();
  });

  return Object.freeze({ load, pause, stop, seek, getState,
    subscribe(listener) { listeners.add(listener); listener(getState()); return () => listeners.delete(listener); },
    play() {
      if (!record || !['paused', 'ended'].includes(status) || destroyed) return getState();
      if (selected === record.stepRecords.length - 1) { selected = 0; emit(true); }
      status = 'playing'; emit(); schedule(); return getState();
    },
    step(delta) { return seek(selected + (Number.isFinite(delta) ? Math.sign(delta) : 0)); },
    setSpeed(value) {
      if (![0.5, 1, 1.5, 2].includes(value)) throw new TypeError('Choose a playback pace of 0.5, 1, 1.5, or 2.');
      speed = value; emit(); schedule(); return getState();
    },
    destroy() { stop(); destroyed = true; unsubscribe(); listeners.clear(); },
  });
}
