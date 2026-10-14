const EXAMPLES = Object.freeze([
  Object.freeze({ id: 'devnet-transaction', title: 'Follow a transaction through the engine', taskType: 'transaction', network: 'devnet',
    description: 'Replay a real Devnet record to explore accounts, instructions, and balance changes.',
    label: 'Recorded Example', recordedAt: '2026-10-14T13:20:52.537Z', sourceLabel: 'Solana public Devnet RPC',
    file: 'devnet-transaction.json', sourceRecord: 'docs/evidence/live-preview-transaction.json' }),
  Object.freeze({ id: 'mainnet-failed-v1', title: 'Inspect a failed on-chain transaction', taskType: 'transaction', network: 'mainnet-beta',
    description: 'Replay a real version 1 transaction with an on-chain error; the inspection itself completed.',
    label: 'Recorded Example', recordedAt: '2026-10-14T13:26:22.796Z', sourceLabel: 'Solana public Mainnet Beta RPC',
    file: 'mainnet-failed-v1.json', sourceRecord: 'docs/evidence/live-preview-mainnet-v1.json' }),
]);
const copy = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));

export function getRecordedExamples() { return EXAMPLES.map(example => ({ ...example })); }

/**
 * Load a packaged public record, never an RPC response or a browser-store record.
 * The catalogue is a fixed allowlist; no user-supplied URL is fetched.
 * @param {string} id
 * @param {{fetchImpl?: typeof fetch}} [options]
 */
export async function loadRecordedExample(id, { fetchImpl = globalThis.fetch } = {}) {
  const definition = EXAMPLES.find(example => example.id === id);
  if (!definition) throw new TypeError('Choose a recorded example from the catalogue.');
  const response = await fetchImpl(new URL(`./examples/${definition.file}`, import.meta.url));
  if (!response.ok) throw new Error('This recorded example could not be loaded. Retry the example.');
  const source = await response.json();
  if (!source?.runId || !source.result?.raw || source.taskType !== definition.taskType || source.network !== definition.network
    || !Array.isArray(source.stepRecords) || source.stepRecords.length !== 6) throw new Error('The recorded example has an unexpected structure.');
  const originalRunId = source.runId;
  return { ...copy(source), runId: `example:${definition.id}`, recordKind: 'RecordedExample', exampleId: definition.id,
    storageScope: 'packaged-example', mode: 'replay', observationKind: 'recorded-example',
    trigger: { kind: 'recorded-example', detail: 'Explicit historical example selection. This is not a new chain event or query.' },
    exampleSource: { label: definition.label, sourceRecord: definition.sourceRecord, sourceLabel: definition.sourceLabel,
      originalRunId, recordedAt: definition.recordedAt, capturedReadOnly: true,
      limitation: 'Packaged public evidence. Replay does not refresh chain data, save a new record, or increase execution counts.' } };
}
