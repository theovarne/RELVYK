import { createEvidenceStore, createLocalId } from './evidence-store.js';
import { defaultTemplateFor, ruleVersionFor } from './reflex-library.js';
import { validateInput } from './solana/validation.js';

export const TASK_STAGES = Object.freeze(['SENSE', 'PLAN', 'AUTHORIZE', 'EXECUTE', 'VERIFY', 'REMEMBER']);
const NETWORKS = ['mainnet-beta', 'devnet', 'testnet'];
const clone = (value) => value === undefined ? undefined : typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();

function normalizedChecks(checks = []) {
  return checks.map((check, index) => ({
    ...check, id: check.id || `check-${index + 1}`, title: check.title || check.label || `Check ${index + 1}`,
    label: check.label || check.title || `Check ${index + 1}`,
    status: ['pass', 'fail', 'unknown'].includes(check.status) ? check.status : 'unknown',
    finding: check.finding || 'The source did not provide a finding.', evidence: check.evidence ?? [],
  }));
}

function checkSummary(checks) {
  return checks.reduce((summary, check) => { summary[check.status] += 1; return summary; }, { pass: 0, fail: 0, unknown: 0 });
}

function publicError(error) {
  const codes = {
    ABORTED: 'This query was cancelled.',
    TIMEOUT: 'The data source timed out. Retry the same input.',
    RPC_TIMEOUT: 'The data source timed out. Retry the same input.',
    RATE_LIMITED: 'The data source is limiting requests. Retry after a short pause.',
    RPC_RATE_LIMITED: 'The data source is limiting requests. Retry after a short pause.',
    NETWORK_ERROR: 'The data source could not be reached. Check your connection and retry.',
    UNSUPPORTED_VERSION: 'This source could not read the transaction version.',
  };
  const code = typeof error?.code === 'string' ? error.code : 'QUERY_FAILED';
  return { code, message: codes[code] || (typeof error?.message === 'string' && !/https?:\/\/|stack|secret|token=/i.test(error.message) ? error.message.slice(0, 300) : 'The source could not complete this read. Retry the same input.'), retryable: error?.retryable !== false };
}

/** @param {import('./evidence-store.js').StorageStatus} storageStatus */
function initialState(storageStatus) {
  return {
    status: 'idle', mode: 'query', stage: 'INPUT', runId: null, task: null,
    stepRecords: [], checks: [], result: null, record: null, error: null,
    startedAt: null, completedAt: null, observedAt: null, dataSource: null,
    verificationSummary: { pass: 0, fail: 0, unknown: 0 }, storageStatus,
  };
}

/**
 * @typedef {{kind?: string, eventId?: string, eventIds?: string[]}} TaskTrigger
 * @typedef {{type?: string, input?: string, network?: string, templateId?: string, templateVersion?: string, trigger?: TaskTrigger}} TaskRequest
 * @typedef {{stage: string, status: string, startedAt: string, completedAt: string | null, summary: string, evidenceRefs: unknown[]}} StepRecord
 * @typedef {{store?: ReturnType<typeof createEvidenceStore>, services?: Partial<typeof import('./solana/client.js')>, onChange?: (state: ReturnType<typeof initialState>) => void}} TaskEngineOptions
 */

/**
 * One state source drives task progress, model feedback, results and evidence.
 * @param {TaskEngineOptions} [options]
 */
export function createTaskEngine({ store = createEvidenceStore(), services, onChange } = {}) {
  const listeners = new Set();
  let state = initialState(store.status);
  let generation = 0;
  let controller = null;
  let providerPromise;

  if (typeof onChange === 'function') listeners.add(onChange);
  const storageUnsubscribe = store.subscribeStatus?.((storageStatus) => {
    state = { ...state, storageStatus };
    publish();
  });

  function publish() {
    for (const listener of listeners) {
      try { listener(clone(state)); } catch { /* A broken view cannot alter the task. */ }
    }
  }

  function update(patch) { state = { ...state, ...patch }; publish(); }
  function current(token) { return token === generation && !controller?.signal.aborted; }
  function assertCurrent(token) { if (!current(token)) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' }); }

  async function provider() {
    if (services) return services;
    providerPromise ||= import('./solana/client.js');
    return providerPromise;
  }

  function beginStep(stage, summary) {
    const entry = { stage, status: 'running', startedAt: now(), completedAt: null, summary, evidenceRefs: [] };
    update({ stage, stepRecords: [...state.stepRecords, entry] });
  }

  function finishStep(summary, evidenceRefs = [], status = 'complete') {
    const steps = [...state.stepRecords];
    if (steps.length) steps[steps.length - 1] = { ...steps[steps.length - 1], status, summary, evidenceRefs: clone(evidenceRefs), completedAt: now() };
    update({ stepRecords: steps });
  }

  function cancel() {
    generation += 1;
    controller?.abort();
    controller = null;
    if (state.status === 'running' || state.status === 'replay') {
      const stepRecords = state.stepRecords.map((step) => step.status === 'running' ? { ...step, status: 'cancelled', completedAt: now(), summary: 'Cancelled by the user or superseded by another input.' } : step);
      update({ status: 'cancelled', completedAt: now(), stepRecords, error: null });
    }
  }

  /** @param {TaskRequest} [request] */
  async function run({ type, input, network = 'mainnet-beta', templateId, templateVersion, trigger } = {}) {
    cancel();
    const token = generation;
    controller = new AbortController();
    const runController = controller;
    const fallbackTemplate = defaultTemplateFor(type);
    const task = { type, input: typeof input === 'string' ? input.trim() : '', network, templateId: templateId || fallbackTemplate?.id || null, templateVersion: templateVersion || fallbackTemplate?.version || null };
    update({ ...initialState(store.status), status: 'running', mode: 'query', task, runId: createLocalId('run'), startedAt: now() });
    let executed = false;
    let queryError = null;
    let result = null;
    let snapshot = null;
    let api;

    try {
      beginStep('SENSE', 'Identify the public Solana object and selected network.');
      if (!fallbackTemplate || !NETWORKS.includes(network)) throw Object.assign(new Error('Choose a supported task and Solana network.'), { code: 'INVALID_INPUT', retryable: false });
      const validation = validateInput(type, task.input);
      if (!validation.valid) throw Object.assign(new Error(validation.error || 'The task input is invalid.'), { code: 'INVALID_INPUT', retryable: false });
      api = await provider();
      assertCurrent(token);
      task.input = validation.value || task.input;
      update({ task: { ...task } });
      finishStep(`Recognized a ${type === 'transaction' ? 'transaction signature' : type === 'token' ? 'Mint address' : 'public account address'} on ${network}.`);

      beginStep('PLAN', 'Select the defined read and verification rules.');
      if (task.templateId !== fallbackTemplate.id) {
        const savedTemplate = await store.getReflex(task.templateId);
        assertCurrent(token);
        if (!savedTemplate || savedTemplate.type !== type || savedTemplate.version !== task.templateVersion) throw Object.assign(new Error('This Reflex version is unavailable. Select a current template.'), { code: 'INVALID_TEMPLATE', retryable: false });
        if (ruleVersionFor(savedTemplate) !== fallbackTemplate.version) throw Object.assign(new Error(`This copy uses older checks. Save a new copy of the current ${fallbackTemplate.title} template.`), { code: 'INVALID_TEMPLATE', retryable: false });
      } else if (task.templateVersion !== fallbackTemplate.version) {
        throw Object.assign(new Error('This Reflex version is unavailable. Select a current template.'), { code: 'INVALID_TEMPLATE', retryable: false });
      }
      finishStep(`Use ${fallbackTemplate.title}, with check rules ${fallbackTemplate.version}${task.templateId !== fallbackTemplate.id ? ` and parameter copy ${task.templateVersion}` : ''}. No model inference or remote script is used.`);

      beginStep('AUTHORIZE', 'Check that the selected workflow is public and read-only.');
      const serviceName = { transaction: 'inspectTransaction', token: 'inspectToken', snapshot: 'createSnapshot' }[type];
      if (typeof api[serviceName] !== 'function') throw Object.assign(new Error('The selected data reader is unavailable. Retry after reloading.'), { code: 'READER_UNAVAILABLE' });
      finishStep('Public read authorized. No wallet connection, asset approval or transaction signature is requested.');

      beginStep('EXECUTE', `Read ${type === 'transaction' ? 'transaction and instruction' : type === 'token' ? 'Mint and authority' : 'account and Token Account'} data from the selected network.`);
      try {
        executed = true;
        const response = await api[serviceName](task.input, network, { signal: runController.signal });
        assertCurrent(token);
        if (!response || !response.summary || typeof response.summary !== 'object' || Array.isArray(response.summary) || !Array.isArray(response.checks) || typeof response.observedAt !== 'string' || !Number.isFinite(Date.parse(response.observedAt))) throw Object.assign(new Error('The data source returned an unexpected response structure.'), { code: 'INVALID_RESPONSE' });
        result = { ...response, checks: normalizedChecks(response.checks) };
        if (type === 'snapshot') {
          await store.ready;
          assertCurrent(token);
          const capture = result;
          const snapshots = await store.listSnapshots({ owner: task.input, network });
          const previous = snapshots.sort((a, b) => Date.parse(b.savedAt || b.observedAt) - Date.parse(a.savedAt || a.observedAt))[0];
          assertCurrent(token);
          if (!previous) {
            result = { ...result, comparison: null, comparisonStatus: 'baseline-created', comparisonReason: 'This is the first saved snapshot for this account and network. Run again to compare two actual observations.' };
          } else {
            const baselineRef = { kind: 'local-snapshot', snapshotId: previous.snapshotId, observedAt: previous.observedAt, storageScope: previous.storageScope };
            let comparison = null;
            let limitation = null;
            try {
              if (Date.parse(previous.observedAt) > Date.parse(result.observedAt)) throw new Error('The current source observation predates the latest saved capture. It may be cached. Retry for fresh data before comparing this capture.');
              if (typeof api.compareSnapshots !== 'function') throw new Error('The snapshot comparator is unavailable. This source capture is still saved; reload before comparing it.');
              const compared = await api.compareSnapshots(previous, capture);
              assertCurrent(token);
              if (!compared || !compared.summary || !Array.isArray(compared.checks)) throw new Error('The snapshot comparator did not return its defined checks. This source capture is still saved.');
              comparison = compared;
            } catch (error) {
              if (!current(token) || error?.name === 'AbortError') throw error;
              limitation = publicError(error).message;
            }
            result = { ...result, comparison, comparisonStatus: comparison ? 'compared' : 'comparison-unavailable', comparisonReason: limitation, checks: [...result.checks, ...normalizedChecks(comparison?.checks || [{ id: 'snapshot-time-range', label: 'Snapshot comparison is available', status: 'unknown', finding: limitation, evidence: [baselineRef], limitation: 'No difference is inferred from an unavailable or out-of-order comparison.' }])], evidenceRefs: [...(result.evidenceRefs || []), baselineRef] };
          }
          snapshot = { snapshotId: createLocalId('snapshot'), network, owner: task.input, input: task.input, observedAt: capture.observedAt, slot: capture.summary.slot ?? null, summary: clone(capture.summary), raw: clone(capture.raw), dataSource: clone(capture.dataSource), evidenceRefs: clone(capture.evidenceRefs || []), capturedByRunId: state.runId };
        }
        update({ result, observedAt: result.observedAt || null, dataSource: result.dataSource || null });
        finishStep(result.summary.taskStatus === 'incomplete' ? 'The source returned limited or missing data. The result preserves this limitation.' : 'Public data was returned and parsed. The query did not broadcast a chain transaction.', result.evidenceRefs || []);
      } catch (error) {
        if (!current(token) || error?.name === 'AbortError') throw error;
        queryError = publicError(error);
        finishStep(queryError.message, [], 'failed');
      }

      beginStep('VERIFY', 'Record each defined check as passed, failed or unknown.');
      const checks = result ? normalizedChecks(result.checks) : [{ id: 'source-read', title: 'The source returned usable data', label: 'The source returned usable data', status: 'unknown', finding: queryError?.message || 'The source did not return usable data.', evidence: [], limitation: 'No chain conclusion can be made from a failed read.' }];
      const summary = checkSummary(checks);
      update({ checks, verificationSummary: summary, error: queryError });
      finishStep(`${summary.pass} passed · ${summary.fail} failed · ${summary.unknown} unknown. These checks are not a security audit.`, result?.evidenceRefs || []);

      beginStep('REMEMBER', 'Save the observation, checks and processing evidence in this browser.');
      await store.ready;
      assertCurrent(token);
      if (snapshot) {
        snapshot = await store.saveSnapshot({ ...snapshot, savedAt: now() });
        assertCurrent(token);
        result = { ...result, snapshotId: snapshot.snapshotId };
      }
      const completedAt = now();
      // Commit the same stage records shown by the interface; no replay creates a new run.
      finishStep(store.status.persistent ? 'Saved in this browser. The record is not public or on-chain.' : 'Kept in this page session. Browser persistence is unavailable; export the record to keep it.');
      const outcome = queryError ? 'error' : result?.summary.taskStatus === 'incomplete' ? 'incomplete' : 'completed';
      // A session queue may discover additional events while this read is pending.
      // Capture its current event identity list when committing the single run.
      const eventIds = trigger?.kind === 'session-observation' && Array.isArray(trigger.eventIds) ? [...new Set(trigger.eventIds.filter(id => typeof id === 'string' && id.length > 0).map(id => id.slice(0, 300)))].slice(0, 200) : [];
      let record = {
        runId: state.runId, taskType: type, network, input: task.input,
        dataSource: result?.dataSource || { kind: 'solana-rpc', network, detail: 'No usable response returned' },
        observedAt: result?.observedAt || null, startedAt: state.startedAt, completedAt,
        stepRecords: clone(state.stepRecords), checks: clone(checks), result: clone(result),
        evidenceRefs: clone(result?.evidenceRefs || []), templateId: task.templateId, templateVersion: task.templateVersion, ruleVersion: fallbackTemplate.version,
        storageScope: store.status.storageScope, mode: 'query', trigger: trigger?.kind === 'session-observation' ? { kind: 'session-observation', detail: 'A read-only page-session observer found an external signature.', eventId: typeof trigger.eventId === 'string' ? trigger.eventId.slice(0, 300) : null, eventIds } : { kind: 'user-query', detail: 'A user requested a public read.' },
        observationKind: result?.cached ? 'cached-query' : 'live-query', cache: { reused: Boolean(result?.cached), ageMs: Number.isFinite(result?.cacheAgeMs) ? result.cacheAgeMs : null }, executionKind: 'public-read', executed, outcome,
        chainExecution: type === 'transaction' ? { initiatedByApplication: false, actor: 'external', actorKnown: false, signersObserved: clone(result?.summary.chainExecutor || []), attributionLimitation: result?.summary.executorLimitation || 'The person or service controlling the signer keys is not independently identified.', status: result?.summary.chainStatus || 'unknown', finality: result?.summary.finality || 'unknown' } : null,
        verificationSummary: summary, error: queryError,
      };
      assertCurrent(token);
      record = await store.saveRecord(record);
      assertCurrent(token);
      if (record.storageScope !== 'local' && state.stepRecords.at(-1)?.summary.startsWith('Saved in this browser.')) {
        finishStep('Kept in this page session. Browser persistence is unavailable; export the record to keep it.');
        record = await store.saveRecord({ ...record, stepRecords: clone(state.stepRecords) });
        assertCurrent(token);
      }
      update({ status: queryError ? 'error' : 'complete', result, record, completedAt, error: queryError, storageStatus: store.status });
      return clone(record);
    } catch (error) {
      if (!current(token) || error?.name === 'AbortError') return null;
      const failure = publicError(error);
      finishStep(failure.message, [], 'failed');
      update({ status: 'error', error: failure, completedAt: now() });
      return null;
    }
  }

  /** @param {string | object} recordOrId @param {{onStep?: (step: StepRecord, state: ReturnType<typeof initialState>) => unknown | Promise<unknown>}} [options] */
  async function replay(recordOrId, { onStep } = {}) {
    cancel();
    const token = generation;
    controller = new AbortController();
    const record = typeof recordOrId === 'string' ? await store.getRecord(recordOrId) : clone(recordOrId);
    if (!current(token)) return null;
    if (!record?.runId || !Array.isArray(record.stepRecords)) throw new Error('A saved task record is required for replay.');
    update({ ...initialState(store.status), status: 'replay', mode: 'replay', runId: record.runId, task: { type: record.taskType, input: record.input, network: record.network, templateId: record.templateId, templateVersion: record.templateVersion }, record: clone(record), startedAt: record.startedAt, observedAt: record.observedAt, dataSource: record.dataSource });
    try {
      for (const step of record.stepRecords) {
        assertCurrent(token);
        update({ stage: step.stage, stepRecords: [...state.stepRecords, clone(step)] });
        if (typeof onStep === 'function') await onStep(clone(step), clone(state));
      }
      assertCurrent(token);
      update({ status: 'complete', checks: normalizedChecks(record.checks), result: clone(record.result), verificationSummary: checkSummary(normalizedChecks(record.checks)), error: record.error || null, completedAt: record.completedAt });
      return clone(record);
    } catch (error) {
      if (!current(token) || error?.name === 'AbortError') return null;
      update({ status: 'error', error: publicError(error) });
      return null;
    }
  }

  return {
    getState: () => clone(state), run, cancel, replay,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('A task subscriber must be a function.');
      listeners.add(listener); listener(clone(state));
      return () => listeners.delete(listener);
    },
    destroy() { cancel(); storageUnsubscribe?.(); listeners.clear(); },
  };
}
