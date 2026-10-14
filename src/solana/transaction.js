import { exactInteger, formatAmount, integerOrNull } from './precision.js';
import { explorerUrl, validateInput } from './validation.js';
import { rpcWithEvidence, RpcError } from './transport.js';

export const check = (id, label, status, finding, evidence, limitation) => ({ id, label, title: label, status, finding, evidence, ...(limitation ? { limitation } : {}) });
export function evidenceRef(id, method, path, read) { return { id, method, path, dataSource: read.dataSource, observedAt: read.observedAt, cached: Boolean(read.cache?.hit), cacheAgeMs: read.cache?.ageMs || 0 }; }

function accountsFor(transaction) {
  const message = transaction.transaction?.message;
  if (!Array.isArray(message?.accountKeys)) return [];
  const header = message.header || {};
  const signers = header.numRequiredSignatures || 0, readonlySigned = header.numReadonlySignedAccounts || 0, readonlyUnsigned = header.numReadonlyUnsignedAccounts || 0;
  const keys = message.accountKeys.map((key, index) => typeof key === 'string' ? {
    address: key, index, signer: index < signers,
    writable: index < signers ? index < signers - readonlySigned : index < message.accountKeys.length - readonlyUnsigned,
    source: 'transaction',
  } : { address: key?.pubkey || null, index, signer: key?.signer ?? null, writable: key?.writable ?? null, source: key?.source || 'transaction' });
  const loaded = transaction.meta?.loadedAddresses;
  // jsonParsed expands lookup-table keys already. In raw/string-key responses,
  // wire order is static keys, loaded writable keys, then loaded readonly keys.
  const hasExpandedKeys = keys.some(key => key.source === 'lookupTable');
  const loadedCount = (loaded?.writable?.length || 0) + (loaded?.readonly?.length || 0);
  const balanceCount = transaction.meta?.preBalances?.length;
  if (transaction.version !== 1 && !hasExpandedKeys && loadedCount && (typeof message.accountKeys[0] === 'string' || balanceCount === keys.length + loadedCount)) {
    /** @type {Array<['writable' | 'readonly', boolean]>} */
    const loadedGroups = [['writable', true], ['readonly', false]];
    for (const [name, writable] of loadedGroups) for (const address of loaded[name] || []) keys.push({ address, index: keys.length, signer: false, writable, source: 'lookupTable' });
  }
  return keys;
}

function normalizeInstruction(instruction, accounts, index, parentIndex = null) {
  const resolve = value => Number.isInteger(value) ? accounts[value]?.address || null : typeof value === 'string' ? value : null;
  const programId = instruction.programId || resolve(instruction.programIdIndex);
  const explicitAccounts = Array.isArray(instruction.accounts) ? instruction.accounts.map(resolve) : [];
  const info = instruction.parsed?.info;
  const parsedAccounts = info && typeof info === 'object' ? Object.values(info).filter(value => typeof value === 'string' && validateInput('address', value).valid) : [];
  return {
    id: parentIndex === null ? `instruction:${index}` : `instruction:${parentIndex}:inner:${index}`,
    index, parentIndex, level: parentIndex === null ? 'top' : 'inner',
    programId: typeof programId === 'string' ? programId : null,
    program: instruction.parsed ? instruction.program || 'RPC parsed program' : 'Unparsed program',
    type: instruction.parsed?.type || 'Unparsed instruction',
    parsed: instruction.parsed || null,
    accounts: explicitAccounts.length ? explicitAccounts : [...new Set(parsedAccounts)],
    data: typeof instruction.data === 'string' ? instruction.data : null,
    stackHeight: instruction.stackHeight ?? null,
    raw: instruction,
    limitation: instruction.parsed ? null : 'No protocol classification is inferred from this instruction. Its program ID and original payload are retained.',
  };
}

function balanceChanges(meta, accounts) {
  const sol = [];
  if (Array.isArray(meta?.preBalances) && Array.isArray(meta?.postBalances)) {
    for (let index = 0; index < Math.max(meta.preBalances.length, meta.postBalances.length); index++) {
      const before = integerOrNull(meta.preBalances[index]), after = integerOrNull(meta.postBalances[index]);
      if (before === null || after === null) { sol.push({ accountIndex: index, account: accounts[index]?.address || null, before, after, delta: null, formattedDelta: null }); continue; }
      const delta = exactInteger(after) - exactInteger(before);
      sol.push({ accountIndex: index, account: accounts[index]?.address || null, before, after, delta: delta.toString(), formattedBefore: formatAmount(before, 9), formattedAfter: formatAmount(after, 9), formattedDelta: formatAmount(delta, 9), unit: 'SOL' });
    }
  }
  const tokens = [], beforeAvailable = Array.isArray(meta?.preTokenBalances), afterAvailable = Array.isArray(meta?.postTokenBalances);
  const pairs = new Map();
  const knownPrograms = new Map();
  for (const row of [...(meta?.preTokenBalances || []), ...(meta?.postTokenBalances || [])]) {
    if (!row || !Number.isInteger(row.accountIndex) || typeof row.mint !== 'string' || typeof row.programId !== 'string') continue;
    const key = `${row.accountIndex}:${row.mint}`, programs = knownPrograms.get(key) || new Set();
    programs.add(row.programId); knownPrograms.set(key, programs);
  }
  for (const [side, rows] of [['before', meta?.preTokenBalances || []], ['after', meta?.postTokenBalances || []]]) {
    for (const row of rows) {
      if (!row || !Number.isInteger(row.accountIndex) || typeof row.mint !== 'string') continue;
      const known = knownPrograms.get(`${row.accountIndex}:${row.mint}`);
      const program = row.programId || (known?.size === 1 ? [...known][0] : null);
      const key = `${row.accountIndex}:${row.mint}:${program || 'unknown'}`;
      const pair = pairs.get(key) || { accountIndex: row.accountIndex, account: accounts[row.accountIndex]?.address || null, mint: row.mint, program };
      pair[side] = row; pairs.set(key, pair);
    }
  }
  for (const pair of pairs.values()) {
    const a = pair.before, b = pair.after, decimals = b?.uiTokenAmount?.decimals ?? a?.uiTokenAmount?.decimals;
    const before = a ? integerOrNull(a.uiTokenAmount?.amount) : beforeAvailable ? '0' : null;
    const after = b ? integerOrNull(b.uiTokenAmount?.amount) : afterAvailable ? '0' : null;
    const decimalValid = Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 && !(a && b && a.uiTokenAmount?.decimals !== b.uiTokenAmount?.decimals);
    const delta = before !== null && after !== null ? (exactInteger(after) - exactInteger(before)).toString() : null;
    tokens.push({ accountIndex: pair.accountIndex, account: pair.account, mint: pair.mint, program: pair.program, owner: b?.owner || a?.owner || null, beforeOwner: a?.owner || null, afterOwner: b?.owner || null, before, after, delta, decimals: decimalValid ? decimals : null, formattedBefore: before !== null && decimalValid ? formatAmount(before, decimals) : null, formattedAfter: after !== null && decimalValid ? formatAmount(after, decimals) : null, formattedDelta: delta !== null && decimalValid ? formatAmount(delta, decimals) : null });
  }
  return { sol, tokens, solAvailable: Array.isArray(meta?.preBalances) && Array.isArray(meta?.postBalances), tokensAvailable: beforeAvailable && afterAvailable, limitation: 'Balance changes include fees, account creation or closure, and wrapped SOL. They are observations, not a buy/sell classification or investment profit.' };
}

function resourceConfiguration(transaction, accounts) {
  const message = transaction.transaction.message, source = message.transactionConfig;
  const label = 'Version-specific resource configuration';
  const limitation = 'Version 1 limits come from the signed message transactionConfig. Priority fee is a total in lamports, not micro-lamports per compute unit. ComputeBudget instructions do not set version 1 limits. Signed fee configuration is separate from the fee charged in meta.fee.';
  if (transaction.version !== 1) return {
    summary: null,
    rule: check('transaction-config', label, source === undefined ? 'pass' : 'unknown', source === undefined ? 'Legacy and version 0 messages do not contain a transactionConfig field.' : 'An unexpected transactionConfig field was returned for this message version.', 'transaction.version; transaction.message.transactionConfig', 'Legacy/version 0 resource settings are not inferred by this inspector. The original instructions remain available.'),
  };
  const fields = ['computeUnitLimit', 'heapSize', 'loadedAccountsDataSizeLimit', 'priorityFee'];
  const present = Boolean(source && typeof source === 'object' && !Array.isArray(source));
  /** @type {Record<string, 'set' | 'unset' | 'unknown'>} */
  const states = {};
  /** @type {Record<string, string | null>} */
  const values = {};
  for (const name of fields) {
    values[name] = null; states[name] = 'unknown';
    if (!present || !Object.hasOwn(source, name)) continue;
    if (source[name] === null) { states[name] = 'unset'; continue; }
    const value = integerOrNull(source[name]), maximum = name === 'priorityFee' ? 18446744073709551615n : 4294967295n;
    if (value !== null && exactInteger(value) <= maximum) { values[name] = value; states[name] = 'set'; }
  }
  const fieldsComplete = present && fields.every(name => states[name] !== 'unknown') && Object.keys(source).every(name => fields.includes(name));
  const noALTs = !message.addressTableLookups?.length && !transaction.meta?.loadedAddresses?.writable?.length && !transaction.meta?.loadedAddresses?.readonly?.length && !accounts.some(account => account.source === 'lookupTable');
  const requiredSet = states.computeUnitLimit === 'set' && states.loadedAccountsDataSizeLimit === 'set' && exactInteger(values.computeUnitLimit) > 0n && exactInteger(values.loadedAccountsDataSizeLimit) > 0n;
  return {
    summary: { present, fieldsComplete, computeUnitLimit: values.computeUnitLimit, heapSize: values.heapSize, loadedAccountsDataSizeLimit: values.loadedAccountsDataSizeLimit, priorityFee: values.priorityFee, priorityFeeSOL: values.priorityFee === null ? null : formatAmount(values.priorityFee, 9), fieldStates: states, priorityFeeUnit: 'total lamports', noAddressLookupTables: noALTs, source: 'transaction.message.transactionConfig', raw: present ? source : null, limitation },
    rule: check('transaction-config', label, !fieldsComplete || !noALTs ? 'unknown' : requiredSet ? 'pass' : 'fail', !present ? 'The version 1 transactionConfig object was not returned.' : !fieldsComplete ? 'Some signed resource configuration fields were missing, invalid, or unrecognized.' : !noALTs ? 'The returned version 1 response contained unexpected lookup-table references.' : requiredSet ? 'The signed version 1 resource limits and explicit optional fields were read.' : 'The signed version 1 compute or account-data limit is explicitly unset or zero.', 'transaction.version; transaction.message.transactionConfig; message account sources', limitation),
  };
}

export function normalizeTransaction(signature, network, read, statusRead = null, statusFailure = null) {
  const transaction = read.result, status = statusRead?.result?.value?.[0] || null;
  const refs = [evidenceRef('transaction', 'getTransaction', 'result', read)];
  if (statusRead) refs.push(evidenceRef('finality', 'getSignatureStatuses', 'result.value[0]', statusRead));
  const common = { network, input: signature, signature, explorerUrl: explorerUrl('transaction', signature, network), requestedCommitment: 'confirmed' };
  const statusFinality = ['processed', 'confirmed', 'finalized'].includes(status?.confirmationStatus) ? status.confirmationStatus : null;
  if (transaction === null) return {
    kind: 'transaction', summary: { ...common, taskStatus: 'incomplete', chainStatus: status && Object.hasOwn(status, 'err') ? (status.err === null ? 'succeeded' : 'failed') : 'unknown', finality: statusFinality || 'unknown', slot: status ? integerOrNull(status.slot) : null, blockTime: null, instructions: [], accounts: [], programs: [], balanceChanges: { sol: [], tokens: [], solAvailable: false, tokensAvailable: false }, logs: [], feeLamports: null, feeSOL: null, error: status?.err ?? null, version: null },
    checks: [check('transaction-available', 'Transaction data available', 'unknown', 'The selected data source did not return this transaction at confirmed commitment.', 'getTransaction result = null', 'It may be unavailable, not yet confirmed, on another network, or outside this provider’s retained history. Null does not prove that it never existed.')],
    raw: { transaction, signatureStatus: statusRead?.result || null, statusReadError: statusFailure }, evidenceRefs: refs, observedAt: read.observedAt, dataSource: read.dataSource, cached: refs.some(ref => ref.cached), cacheAgeMs: Math.max(...refs.map(ref => ref.cacheAgeMs)),
  };
  if (!transaction || typeof transaction !== 'object' || !transaction.transaction?.message) throw new RpcError('INVALID_RESPONSE', 'The RPC returned transaction data without a usable message.', true);
  if (transaction.version !== undefined && transaction.version !== 'legacy' && transaction.version !== 0 && transaction.version !== 1) throw new RpcError('UNSUPPORTED_VERSION', 'This inspector supports legacy, version 0, and version 1 transactions. The returned transaction version is unsupported.');
  const meta = transaction.meta, accounts = accountsFor(transaction);
  const top = transaction.transaction.message.instructions;
  if (!Array.isArray(top)) throw new RpcError('INVALID_RESPONSE', 'The transaction message did not include an instruction list.', true);
  const instructions = top.map((instruction, index) => normalizeInstruction(instruction, accounts, index));
  for (const group of meta?.innerInstructions || []) if (Array.isArray(group?.instructions)) for (const [index, instruction] of group.instructions.entries()) instructions.push(normalizeInstruction(instruction, accounts, index, group.index));
  const changes = balanceChanges(meta, accounts), fee = integerOrNull(meta?.fee);
  const config = resourceConfiguration(transaction, accounts);
  const knownError = meta && Object.hasOwn(meta, 'err');
  const chainStatus = knownError ? (meta.err === null ? 'succeeded' : 'failed') : 'unknown';
  const finality = statusFinality || 'confirmed';
  const mappingOK = accounts.length > 0 && accounts.every(account => validateInput('address', account.address).valid) && instructions.every(instruction => validateInput('address', instruction.programId).valid && instruction.accounts.every(account => validateInput('address', account).valid)) && (!changes.solAvailable || accounts.length === meta.preBalances.length && meta.preBalances.length === meta.postBalances.length) && changes.tokens.every(row => row.account !== null);
  const monetaryOK = changes.solAvailable && changes.sol.every(row => row.delta !== null) && fee !== null;
  const checks = [
    check('transaction-available', 'Transaction data available', 'pass', `A ${transaction.version ?? 'legacy'} transaction message was read.`, 'getTransaction.result.transaction.message'),
    check('account-indexes', 'Account indexes resolve', mappingOK ? 'pass' : 'unknown', mappingOK ? 'Instruction and balance indexes resolve against the complete account list.' : 'Some account references could not be resolved.', 'message.accountKeys; meta.loadedAddresses; instruction account indexes', 'Version 0 lookup accounts use the RPC-expanded key order; unresolved references are kept as unknown.'),
    check('chain-outcome', 'Chain execution outcome recorded', knownError ? 'pass' : 'unknown', chainStatus === 'failed' ? 'The chain transaction failed. Its error is retained; the inspection can still complete.' : chainStatus === 'succeeded' ? 'The chain reported no execution error.' : 'Execution metadata was not returned.', 'meta.err', 'This check verifies that the outcome was read, not that the underlying transaction succeeded.'),
    check('finality', 'Finality evidence', statusFinality ? 'pass' : 'unknown', statusFinality ? `The signature status is ${statusFinality}.` : 'The transaction was returned at confirmed commitment; independent signature status was unavailable.', 'getSignatureStatuses.result.value[0].confirmationStatus', statusFinality ? 'Finality is separate from task completion.' : statusFailure || 'A confirmed read does not establish finalized status.'),
    check('sol-integers', 'Exact SOL balance and fee arithmetic', monetaryOK ? 'pass' : 'unknown', monetaryOK ? 'Lamports and fees were parsed without unsafe integer rounding.' : 'Some exact balance or fee fields were not supplied.', 'meta.preBalances; meta.postBalances; meta.fee', changes.limitation),
    check('token-balances', 'Token balance coverage', changes.tokensAvailable && changes.tokens.every(row => row.delta !== null && row.decimals !== null) ? 'pass' : 'unknown', changes.tokensAvailable ? `${changes.tokens.length} Token account balance changes were read.` : 'One or both Token balance arrays were unavailable.', 'meta.preTokenBalances; meta.postTokenBalances', 'A missing array is not a zero balance. No market price or trade intent is inferred.'),
    check('inner-instructions', 'Internal instruction coverage', Array.isArray(meta?.innerInstructions) ? 'pass' : 'unknown', Array.isArray(meta?.innerInstructions) ? `${instructions.filter(row => row.level === 'inner').length} internal instructions were included.` : 'Internal instructions were not returned by this data source.', 'meta.innerInstructions', 'Only instructions present in the RPC response can be inspected.'),
    config.rule,
  ];
  return {
    kind: 'transaction', summary: { ...common, taskStatus: 'completed', chainStatus, finality, finalitySource: statusFinality ? 'signature status' : 'confirmed read commitment', slot: integerOrNull(transaction.slot), blockTime: Number.isSafeInteger(transaction.blockTime) && Number.isFinite(new Date(transaction.blockTime * 1000).getTime()) ? new Date(transaction.blockTime * 1000).toISOString() : null, version: transaction.version ?? 'legacy', transactionConfig: config.summary, accounts, programs: [...new Set(instructions.map(row => row.programId).filter(Boolean))], instructions, balanceChanges: changes, logs: Array.isArray(meta?.logMessages) ? meta.logMessages : [], logsAvailable: Array.isArray(meta?.logMessages), feeLamports: fee, feeSOL: fee !== null ? formatAmount(fee, 9) : null, error: knownError ? meta.err : null, chainExecutor: accounts.filter(row => row.signer).map(row => row.address), executorLimitation: 'Transaction signers are visible. The human or service controlling those keys is not independently identified.' },
    checks, raw: { transaction, signatureStatus: statusRead?.result || null, statusReadError: statusFailure, precision: read.precision }, evidenceRefs: refs, observedAt: read.observedAt, dataSource: read.dataSource, cached: refs.some(ref => ref.cached), cacheAgeMs: Math.max(...refs.map(ref => ref.cacheAgeMs)),
  };
}

/**
 * @param {string} signature
 * @param {string} network
 * @param {{signal?: AbortSignal}} [options]
 */
export async function inspectTransaction(signature, network, options = {}) {
  const validation = validateInput('transaction', signature);
  if (!validation.valid) throw new RpcError('INVALID_INPUT', validation.error);
  const [read, statusResult] = await Promise.all([
    rpcWithEvidence('getTransaction', [validation.value, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }], network, options),
    rpcWithEvidence('getSignatureStatuses', [[validation.value], { searchTransactionHistory: true }], network, options).then(value => ({ value }), error => { if (error.name === 'AbortError') throw error; return { error: error.message }; }),
  ]);
  return normalizeTransaction(validation.value, network, read, 'value' in statusResult ? statusResult.value : null, 'error' in statusResult ? statusResult.error : null);
}
