import { observerEventKey } from './session-observer.js';
import { validateInput, NETWORKS } from './solana/validation.js';

const MAX_PENDING = 20;
const MAX_EVENTS = 200;

/**
 * @typedef {{network:string, signature:string, index:string|number, kind:string, finality?:string} & Record<string,any>} ObservationEvent
 * @typedef {{status?:string,runId?:string|null}} QueueEngineState
 * @typedef {{type:string,input:string,network:string,trigger:{kind:string,eventId:string,eventIds:string[]}}} QueueTaskRequest
 * @typedef {{getState:()=>QueueEngineState,run:(request:QueueTaskRequest)=>Promise<any>,subscribe:(listener:(state:QueueEngineState)=>void)=>()=>void}} ObservationEngine
 * @typedef {{network:string,signature:string,eventIds:Set<string>,status:string,runId:string|null}} QueuedTransaction
 */

/**
 * An explicitly started observer feeds this queue; it never watches accounts itself.
 * Keep every event reference, but read a network/signature only once in this instance.
 * User queries and replay have priority. Completion notifications, not timers, drain it.
 * @param {{engine:ObservationEngine,onComplete?:(record:any,context:{network:string,signature:string,eventIds:string[]})=>void|Promise<void>}} options
 */
export function createObservationQueue({ engine, onComplete }) {
  if (typeof engine?.getState !== 'function' || typeof engine.run !== 'function' || typeof engine.subscribe !== 'function') {
    throw new TypeError('A subscribable task engine is required for observation processing.');
  }
  /** @type {Map<string,ObservationEvent & {eventId:string,queueStatus:string,runId:string|null}>} */
  const references = new Map();
  /** @type {Map<string,QueuedTransaction>} */
  const transactions = new Map();
  /** @type {string[]} */
  const pending = [];
  /** @type {{code:string,message:string,eventId?:string}[]} */
  const gaps = [];
  let gapCount = 0;
  let enabled = false;
  let destroyed = false;
  let scheduled = false;
  let processing = false;
  let activeKey = null;
  let generation = 0;

  function gap(code, message, eventId) {
    gapCount++;
    gaps.push({ code, message, ...(eventId ? { eventId } : {}) });
    if (gaps.length > 20) gaps.shift();
  }

  function getState() {
    return {
      status: destroyed ? 'destroyed' : !enabled ? 'stopped' : processing ? 'running' : pending.length ? 'queued' : 'idle',
      enabled, activeKey, pendingCount: pending.length, eventCount: references.size, gapCount,
      limits: { pending: MAX_PENDING, eventReferences: MAX_EVENTS },
      pending: pending.map(key => {
        const entry = transactions.get(key);
        return { network: entry.network, signature: entry.signature, eventIds: [...entry.eventIds] };
      }),
      events: [...references.values()].map(event => ({ ...event })),
      gaps: gaps.map(entry => ({ ...entry })),
    };
  }

  function engineBusy() {
    const status = engine.getState().status;
    return status === 'running' || status === 'replay';
  }

  function updateReferences(entry) {
    for (const id of entry.eventIds) {
      const reference = references.get(id);
      if (reference) { reference.queueStatus = entry.status; reference.runId = entry.runId; }
    }
  }

  function schedule() {
    if (!enabled || destroyed || scheduled || processing || !pending.length || engineBusy()) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; void drain(); });
  }

  async function drain() {
    if (!enabled || destroyed || processing || !pending.length || engineBusy()) return;
    const key = pending.shift();
    const entry = transactions.get(key);
    const currentGeneration = generation;
    processing = true;
    activeKey = key;
    entry.status = 'running';
    updateReferences(entry);
    try {
      // The busy check and synchronous start have no await between them: a user
      // task cannot be interrupted by a queue item becoming ready in that gap.
      const result = engine.run({ type: 'transaction', input: entry.signature, network: entry.network,
        trigger: { kind: 'session-observation', eventId: entry.eventIds.values().next().value,
          // The engine reads this field when saving the record, including any
          // distinct event references received while its public read was running.
          get eventIds() { return [...entry.eventIds]; } } });
      const record = await result;
      entry.runId = typeof record?.runId === 'string' ? record.runId : null;
      entry.status = !record ? 'cancelled' : record.outcome === 'error' ? 'error' : 'complete';
      updateReferences(entry);
      if (record && typeof onComplete === 'function' && !destroyed && currentGeneration === generation) {
        try { await onComplete(record, { network: entry.network, signature: entry.signature, eventIds: [...entry.eventIds] }); }
        catch { gap('COMPLETION_VIEW_FAILED', 'The observation record was processed, but its view could not refresh.'); }
      }
    } catch {
      entry.status = 'error';
      updateReferences(entry);
      if (!destroyed) gap('OBSERVATION_READ_FAILED', 'An observed transaction read failed. Its event references remain available for manual inspection.');
    } finally {
      processing = false;
      activeKey = null;
      // stop() leaves the task engine alone and prevents further queue work.
      if (enabled && !destroyed) schedule();
    }
  }

  function enqueue(events) {
    if (!Array.isArray(events)) throw new TypeError('Observation events must be an array.');
    if (!enabled || destroyed) return getState();
    for (const event of events) {
      if (!event || !NETWORKS.includes(event.network) || !validateInput('transaction', event.signature).valid
        || !/^[A-Za-z0-9:._-]{1,100}$/.test(String(event.index)) || !/^[a-z][a-z0-9-]{0,79}$/.test(event.kind)) {
        gap('INVALID_OBSERVATION', 'An observation reference did not contain a valid network, signature, index, and kind.');
        continue;
      }
      const id = observerEventKey(event);
      const existing = references.get(id);
      if (existing) {
        // A finalized notification updates evidence without scheduling another read.
        const finality = existing.finality === 'finalized' ? 'finalized' : event.finality;
        references.set(id, { ...existing, ...event, finality, eventId: id,
          queueStatus: existing.queueStatus, runId: existing.runId });
        continue;
      }
      if (references.size >= MAX_EVENTS) {
        gap('EVENT_REFERENCE_LIMIT', `The ${MAX_EVENTS}-event session reference limit was reached. Further events were not queued.`, id);
        continue;
      }
      const key = `${event.network}:${event.signature}`;
      let entry = transactions.get(key);
      if (!entry) {
        entry = { network: event.network, signature: event.signature, eventIds: new Set(), status: 'pending', runId: null };
        transactions.set(key, entry);
        if (pending.length >= MAX_PENDING) {
          entry.status = 'not-queued';
          gap('QUEUE_LIMIT', `The ${MAX_PENDING}-transaction pending limit was reached. This event remains available for manual inspection.`, id);
        } else pending.push(key);
      }
      entry.eventIds.add(id);
      references.set(id, { ...event, eventId: id, queueStatus: entry.status, runId: entry.runId });
    }
    schedule();
    return getState();
  }

  function stop() {
    enabled = false;
    ++generation;
    for (const key of pending.splice(0)) {
      const entry = transactions.get(key);
      entry.status = 'cancelled';
      updateReferences(entry);
    }
    return getState();
  }

  const unsubscribe = engine.subscribe(() => schedule());
  return Object.freeze({ enqueue, stop, getState,
    start() { if (!destroyed) { enabled = true; schedule(); } return getState(); },
    destroy() { stop(); destroyed = true; unsubscribe(); },
  });
}
