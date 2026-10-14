import { createLocalId } from './evidence-store.js';
import { validateInput } from './solana/validation.js';

const CREATED_AT = '2026-10-14T12:19:38.000Z';
const STAGES = ['SENSE', 'PLAN', 'AUTHORIZE', 'EXECUTE', 'VERIFY', 'REMEMBER'];

function template(id, type, title, description, input, checks, version = '1.0.0') {
  return Object.freeze({
    id, type, title, description, version, ruleVersion: version,
    inputSchema: { type: 'object', required: ['input', 'network'], properties: { input: { type: 'string', description: input }, network: { enum: ['mainnet-beta', 'devnet', 'testnet'] } } },
    steps: STAGES.map((stage) => ({ stage, readOnly: true })),
    checks, createdAt: CREATED_AT, lastVerifiedAt: null, executionCount: 0,
    verificationSummary: { executions: 0, completed: 0, incomplete: 0, errors: 0, pass: 0, fail: 0, unknown: 0 },
    evidenceRefs: [], parameters: null, sourceId: null, sourceVersion: null,
  });
}

export const REFLEX_TEMPLATES = Object.freeze([
  template('inspect-transaction', 'transaction', 'Inspect Transaction', 'Read a legacy, version 0 or version 1 Solana transaction; preserve instructions, exact balance changes and version-specific configuration checks.', 'Base58-encoded Solana transaction signature (64 bytes).', [
    { id: 'transaction-available', label: 'Transaction is returned by the selected source', rule: 'transaction-present' },
    { id: 'account-indexes', label: 'Account indexes resolve against the complete key order', rule: 'resolved-account-indexes' },
    { id: 'chain-outcome', label: 'Chain execution outcome is recorded separately', rule: 'execution-status-observed' },
    { id: 'finality', label: 'Confirmed and finalized status remain distinct', rule: 'signature-status-observed' },
    { id: 'sol-integers', label: 'SOL balances and fees preserve exact lamports', rule: 'exact-sol-amounts' },
    { id: 'token-balances', label: 'Token balance changes preserve exact amounts', rule: 'exact-token-amounts' },
    { id: 'inner-instructions', label: 'Internal instruction coverage is explicit', rule: 'returned-inner-instructions' },
    { id: 'transaction-config', label: 'Signed version 1 resource configuration is checked within its explicit scope', rule: 'signed-v1-resource-config', scope: 'For version 1, read computeUnitLimit, heapSize, loadedAccountsDataSizeLimit and priorityFee from transaction.message.transactionConfig. Preserve set, unset and unknown fields; check required limits and unexpected lookup-table references. Priority fee is a total in lamports and is distinct from the charged meta.fee. Legacy/version 0 resource settings are not inferred; their original instructions remain available.' },
  ], '1.1.0'),
  template('inspect-mint-controls', 'token', 'Inspect Mint Controls', 'Read a Mint and check the authority and extension fields the selected source can identify.', 'Base58-encoded Solana Mint address (32 bytes).', [
    { id: 'mint-type', label: 'The account is a Mint of a supported Token Program', rule: 'mint-owner-and-layout' },
    { id: 'mint-initialized', label: 'Mint initialization state is recorded', rule: 'initialization-observed' },
    { id: 'mint-supply', label: 'Supply is read with exact integer precision', rule: 'exact-supply-and-decimals' },
    { id: 'mint-authority', label: 'Mint authority is present, revoked, or unknown', rule: 'authority-observed' },
    { id: 'freeze-authority', label: 'Freeze authority is present, revoked, or unknown', rule: 'authority-observed' },
    { id: 'mint-core-consistency', label: 'Parsed fields agree with the binary Mint layout', rule: 'parsed-and-binary-consistency' },
    { id: 'token-extensions', label: 'Token-2022 extension coverage is explicit', rule: 'extensions-and-limitations' },
    { id: 'token-metadata', label: 'Metadata availability and source are explicit', rule: 'observed-metadata' },
  ]),
  template('compare-account-snapshots', 'snapshot', 'Compare Account Snapshots', 'Capture public SOL and Token Account balances; compare with the previous saved capture for this account and network.', 'Base58-encoded Solana account address (32 bytes).', [
    { id: 'snapshot-sol', label: 'SOL balance is returned by the selected source', rule: 'sol-balance-observed' },
    { id: 'snapshot-original-token', label: 'Original Token Program account coverage is explicit', rule: 'original-token-accounts-observed' },
    { id: 'snapshot-token-2022', label: 'Token-2022 account coverage is explicit', rule: 'token-2022-accounts-observed' },
    { id: 'snapshot-account-coverage', label: 'Missing or unparseable accounts remain visible', rule: 'account-coverage-observed' },
    { id: 'snapshot-integers', label: 'Balances are grouped by Mint and Token Program', rule: 'exact-program-and-mint-balances' },
    { id: 'snapshot-slot-range', label: 'The per-call snapshot slot range is retained', rule: 'context-slots-observed' },
    { id: 'snapshot-identity', label: 'Comparisons use the same account and network', rule: 'same-owner-and-network' },
    { id: 'snapshot-time-range', label: 'Comparison observation times are recorded', rule: 'observation-window' },
    { id: 'snapshot-scope', label: 'Incomplete snapshots never imply missing balances are zero', rule: 'compatible-capture-scope' },
    { id: 'snapshot-deltas', label: 'Deltas use exact integers or remain unknown', rule: 'exact-known-deltas' },
  ]),
]);

export function defaultTemplateFor(type) {
  return REFLEX_TEMPLATES.find((item) => item.type === type) || null;
}

/** The code-check version is separate from a saved parameter copy's own version. */
export function ruleVersionFor(template) {
  return template.ruleVersion || (template.sourceId ? template.sourceVersion : template.version);
}

function copy(value) { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }

/**
 * Templates select predefined code paths; their text is never executable code.
 * @param {{store?: ReturnType<typeof import('./evidence-store.js').createEvidenceStore>, engine?: ReturnType<typeof import('./task-engine.js').createTaskEngine>}} [options]
 */
export function createReflexLibrary({ store, engine } = {}) {
  if (!store) throw new TypeError('A Reflex library requires the local evidence store.');

  async function allTemplates() {
    return [...REFLEX_TEMPLATES.map(copy), ...(await store.listReflexes())];
  }

  async function withStats(item) {
    const records = (await store.listRecords({ templateId: item.id, templateVersion: item.version })).filter((record) => record.mode === 'query' && record.executed === true);
    const summary = { executions: records.length, completed: 0, incomplete: 0, errors: 0, pass: 0, fail: 0, unknown: 0 };
    for (const record of records) {
      summary[record.outcome === 'error' ? 'errors' : record.outcome === 'incomplete' ? 'incomplete' : 'completed'] += 1;
      for (const check of record.checks || []) summary[['pass', 'fail', 'unknown'].includes(check.status) ? check.status : 'unknown'] += 1;
    }
    return { ...copy(item), executionCount: records.length, lastVerifiedAt: records.find((record) => record.outcome === 'completed')?.completedAt || null, verificationSummary: summary, evidenceRefs: records.map((record) => ({ runId: record.runId, kind: 'local-record' })) };
  }

  async function get(id) {
    const item = (await allTemplates()).find((entry) => entry.id === id);
    return item ? withStats(item) : null;
  }

  async function list({ search = '', type = 'all' } = {}) {
    const query = String(search).trim().toLowerCase();
    const items = (await allTemplates()).filter((item) => (type === 'all' || item.type === type) && (!query || `${item.title} ${item.description} ${item.type}`.toLowerCase().includes(query)));
    return Promise.all(items.map(withStats));
  }

  /** @param {string} id @param {{title?: string, input?: string, network?: string}} [parameters] */
  async function saveCopy(id, { title, input, network } = {}) {
    const source = await get(id);
    if (!source) throw new Error('The selected Reflex is no longer available.');
    const currentTemplate = defaultTemplateFor(source.type);
    if (!currentTemplate) throw new Error('This task type has no supported implementation.');
    if (ruleVersionFor(source) !== currentTemplate.version) throw new Error(`This copy uses an older check version. Save a new copy of the current ${currentTemplate.title} template.`);
    if (!['mainnet-beta', 'devnet', 'testnet'].includes(network)) throw new Error('Choose a supported Solana network.');
    if (typeof input !== 'string' || !input.trim()) throw new Error('Save a copy with a task input.');
    const validation = validateInput(source.type, input);
    if (!validation.valid) throw new Error(validation.error || 'The task input is invalid.');
    const now = new Date().toISOString();
    const item = {
      ...copy(source), id: createLocalId('reflex'), title: String(title || `${source.title} · saved parameters`).trim().slice(0, 120),
      version: '1.0.0', ruleVersion: currentTemplate.version, createdAt: now, lastVerifiedAt: null, executionCount: 0,
      verificationSummary: { executions: 0, completed: 0, incomplete: 0, errors: 0, pass: 0, fail: 0, unknown: 0 }, evidenceRefs: [],
      parameters: { input: validation.value || input.trim(), network }, sourceId: source.id, sourceVersion: source.version,
    };
    return store.saveReflex(item);
  }

  /** @param {string} id @param {{input?: string, network?: string}} [overrides] */
  async function run(id, overrides = {}) {
    if (!engine) throw new Error('A task engine is required to run a Reflex.');
    const item = await get(id);
    if (!item) throw new Error('The selected Reflex is no longer available.');
    const parameters = { ...(item.parameters || {}), ...overrides };
    return engine.run({ type: item.type, input: parameters.input, network: parameters.network, templateId: item.id, templateVersion: item.version });
  }

  return { list, get, saveCopy, run, async recentRecords(id, limit = 5) { const item = await get(id); return item ? store.listRecords({ templateId: id, templateVersion: item.version, limit }) : []; } };
}
