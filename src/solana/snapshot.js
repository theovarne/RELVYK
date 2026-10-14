import { exactInteger, formatAmount, integerOrNull } from './precision.js';
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM, explorerUrl, validateInput, normalizeNetwork } from './validation.js';
import { rpcWithEvidence, RpcError } from './transport.js';
import { check, evidenceRef } from './transaction.js';

const MAX_TOKEN_ACCOUNTS = 2000;
const SCOPE = 'Native SOL and public base Token account balances owned by this address under the original Token Program and Token-2022. Excludes compressed assets, NFTs held through other structures, protocol positions, prices, confidential amounts, and assets on other networks.';

export function normalizeSnapshot(owner, network, reads) {
  const balances = new Map(), tokenAccounts = [], errors = [], evidenceRefs = [], contexts = {}, seen = new Set();
  let complete = true, exact = true, truncated = false;
  const successReads = Object.values(reads).filter(read => read && !read.error);
  if (!successReads.length) throw new RpcError('SNAPSHOT_UNAVAILABLE', 'No account snapshot data could be read. Retry the query.', true);
  for (const [name, read] of Object.entries(reads)) {
    if (read.error) { complete = false; errors.push({ source: name, code: read.error.code || 'READ_FAILED', message: read.error.message }); continue; }
    contexts[name] = { slot: integerOrNull(read.result?.context?.slot), observedAt: read.observedAt, cached: Boolean(read.cache?.hit), cacheAgeMs: read.cache?.ageMs || 0 };
    evidenceRefs.push(evidenceRef(`snapshot-${name}`, name === 'sol' ? 'getBalance' : 'getTokenAccountsByOwner', 'result', read));
  }
  const solLamports = reads.sol && !reads.sol.error ? integerOrNull(reads.sol.result?.value) : null;
  if (solLamports === null) { exact = false; complete = false; }
  for (const [name, program] of [['original', TOKEN_PROGRAM], ['token2022', TOKEN_2022_PROGRAM]]) {
    const read = reads[name];
    if (!read || read.error) { complete = false; continue; }
    const rows = read.result?.value;
    if (!Array.isArray(rows)) { complete = false; errors.push({ source: name, code: 'INVALID_RESPONSE', message: 'The Token account list was not available.' }); continue; }
    for (const row of rows) {
      if (tokenAccounts.length >= MAX_TOKEN_ACCOUNTS) { truncated = true; complete = false; break; }
      const info = row?.account?.data?.parsed?.info;
      const amount = integerOrNull(info?.tokenAmount?.amount), decimals = info?.tokenAmount?.decimals;
      const valid = row?.account?.owner === program && row.account?.data?.parsed?.type === 'account' && info?.owner === owner && validateInput('address', row.pubkey).valid && validateInput('token', info?.mint).valid && amount !== null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255;
      if (!valid || seen.has(row.pubkey)) {
        complete = false;
        if (amount === null) exact = false;
        errors.push({ source: name, code: seen.has(row?.pubkey) ? 'DUPLICATE_ACCOUNT' : 'UNPARSED_ACCOUNT', account: typeof row?.pubkey === 'string' ? row.pubkey : null, message: 'A Token account could not be uniquely validated and included.' });
        continue;
      }
      seen.add(row.pubkey);
      const account = { address: row.pubkey, mint: info.mint, program, owner, amount, decimals, formatted: formatAmount(amount, decimals), state: typeof info.state === 'string' ? info.state : null, isNative: typeof info.isNative === 'boolean' ? info.isNative : null, slot: contexts[name]?.slot || null };
      tokenAccounts.push(account);
      const key = `${program}:${info.mint}`, aggregate = balances.get(key) || { mint: info.mint, program, amount: '0', decimals, accountCount: 0, accounts: [] };
      aggregate.amount = (exactInteger(aggregate.amount) + exactInteger(amount)).toString();
      if (aggregate.decimals !== decimals) { aggregate.decimals = null; complete = false; exact = false; }
      aggregate.accountCount++; aggregate.accounts.push(row.pubkey); balances.set(key, aggregate);
    }
  }
  const totals = [...balances.values()].map(balance => ({ ...balance, formatted: balance.decimals !== null ? formatAmount(balance.amount, balance.decimals) : null })).sort((a, b) => a.program.localeCompare(b.program) || a.mint.localeCompare(b.mint));
  const slots = Object.values(contexts).map(context => context.slot).filter(slot => slot !== null).map(BigInt);
  const slotMin = slots.length ? slots.reduce((a, b) => a < b ? a : b).toString() : null, slotMax = slots.length ? slots.reduce((a, b) => a > b ? a : b).toString() : null;
  const observedTimes = successReads.map(read => read.observedAt).filter(time => Number.isFinite(Date.parse(time))).sort();
  const observedAt = observedTimes.at(-1) || new Date().toISOString();
  const programCheck = (name, label) => {
    const read = reads[name], available = read && !read.error && Array.isArray(read.result?.value);
    return check(`snapshot-${name === 'original' ? 'original-token' : 'token-2022'}`, label, available ? 'pass' : 'unknown', available ? `${read.result.value.length} owned Token accounts returned by this program.` : 'The owned Token account list was not available.', `getTokenAccountsByOwner(${name}).result.value`, available ? 'Coverage is limited to public base balances in this response.' : read?.error?.message || 'A missing list is not an empty list.');
  };
  return {
    kind: 'snapshot', summary: { network, input: owner, owner, explorerUrl: explorerUrl('snapshot', owner, network), taskStatus: complete ? 'completed' : 'incomplete', complete, observedAt, readTime: observedAt, readInterval: { from: observedTimes[0] || observedAt, to: observedAt }, slot: contexts.sol?.slot || slotMax, contextSlots: contexts, slotRange: { min: slotMin, max: slotMax }, solLamports, solBalance: solLamports !== null ? formatAmount(solLamports, 9) : null, tokenAccounts, balances: totals, scope: SCOPE, accountLimit: MAX_TOKEN_ACCOUNTS, truncated, errors, atomic: false },
    checks: [
      check('snapshot-sol', 'Native SOL balance read', solLamports !== null ? 'pass' : 'unknown', solLamports !== null ? 'The native account balance was read exactly in lamports.' : 'The native SOL balance was unavailable.', 'getBalance.result.value', reads.sol?.error?.message),
      programCheck('original', 'Original Token Program accounts read'), programCheck('token2022', 'Token-2022 accounts read'),
      check('snapshot-account-coverage', 'Returned account scope validated', complete ? 'pass' : 'unknown', complete ? `${tokenAccounts.length} owned Token accounts were validated and aggregated by Mint and Token Program.` : 'This is a partial snapshot. Unreadable, duplicate, truncated, or missing data is excluded and recorded.', 'getTokenAccountsByOwner account owners, parsed types, Mint IDs, exact amounts', `${SCOPE}${truncated ? ' The 2,000-account inspection limit was reached.' : ''}`),
      check('snapshot-integers', 'Exact snapshot arithmetic', exact ? 'pass' : 'unknown', exact ? 'Public base balances use integer addition and per-Mint decimals.' : 'Some balance or decimal fields could not be read exactly.', 'Token account tokenAmount.amount / decimals; getBalance.value', 'Token-2022 interest or scaled display extensions are not applied to these public base-unit amounts.'),
      check('snapshot-slot-range', 'Snapshot slot scope recorded', slots.length === 3 ? 'pass' : 'unknown', slots.length ? `Read context slots range from ${slotMin} to ${slotMax}.` : 'Read context slots were not available.', 'RPC context.slot for each of the three reads', 'These reads are taken separately at confirmed commitment and do not form an atomic historical state.'),
    ],
    raw: Object.fromEntries(Object.entries(reads).map(([name, read]) => [name, read.error ? { error: { code: read.error.code || 'READ_FAILED', message: read.error.message } } : read.result])),
    evidenceRefs, observedAt, dataSource: successReads[0].dataSource, cached: evidenceRefs.some(ref => ref.cached), cacheAgeMs: Math.max(...evidenceRefs.map(ref => ref.cacheAgeMs)),
  };
}

/**
 * @param {string} owner
 * @param {string} network
 * @param {{signal?: AbortSignal}} [options]
 */
export async function createSnapshot(owner, network, options = {}) {
  const validation = validateInput('snapshot', owner);
  if (!validation.valid) throw new RpcError('INVALID_INPUT', validation.error);
  /** @type {Array<[string, string, unknown[]]>} */
  const jobs = [
    ['sol', 'getBalance', [validation.value, { commitment: 'confirmed' }]],
    ['original', 'getTokenAccountsByOwner', [validation.value, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed', commitment: 'confirmed' }]],
    ['token2022', 'getTokenAccountsByOwner', [validation.value, { programId: TOKEN_2022_PROGRAM }, { encoding: 'jsonParsed', commitment: 'confirmed' }]],
  ];
  const results = await Promise.all(jobs.map(async ([name, method, params]) => {
    try { return [name, await rpcWithEvidence(method, params, network, options)]; }
    catch (error) { if (error.name === 'AbortError') throw error; return [name, { error }]; }
  }));
  return normalizeSnapshot(validation.value, network, Object.fromEntries(results));
}

export function compareSnapshots(previous, current) {
  const a = previous?.summary || previous, b = current?.summary || current;
  if (!a || !b || !validateInput('snapshot', a.owner).valid || !validateInput('snapshot', b.owner).valid || a.owner !== b.owner || a.network !== b.network) throw new RpcError('COMPARISON_MISMATCH', 'Compare snapshots of the same account on the same network.');
  normalizeNetwork(a.network);
  const start = a.observedAt || a.readTime || previous.observedAt, end = b.observedAt || b.readTime || current.observedAt;
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) < Date.parse(start)) throw new RpcError('INVALID_INTERVAL', 'Snapshots must contain valid UTC read times in chronological order.');
  if (!Array.isArray(a.balances) || !Array.isArray(b.balances)) throw new RpcError('INVALID_SNAPSHOT', 'Both snapshots must contain their recorded balance scope.');
  const sameObservation = start === end, complete = a.complete === true && b.complete === true;
  const index = snapshot => new Map(snapshot.balances.map(row => [`${row.program}:${row.mint}`, row]));
  const before = index(a), after = index(b), keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = keys.map(key => {
    const old = before.get(key), fresh = after.get(key), row = fresh || old;
    const priorAmount = old ? integerOrNull(old.amount) : a.complete ? '0' : null;
    const nextAmount = fresh ? integerOrNull(fresh.amount) : b.complete ? '0' : null;
    const decimalValid = Number.isInteger(row.decimals) && row.decimals >= 0 && row.decimals <= 255 && !(old && fresh && old.decimals !== fresh.decimals);
    const delta = priorAmount !== null && nextAmount !== null ? (exactInteger(nextAmount) - exactInteger(priorAmount)).toString() : null;
    return { mint: row.mint, program: row.program, before: priorAmount, after: nextAmount, delta, decimals: decimalValid ? row.decimals : null, formattedBefore: decimalValid && priorAmount !== null ? formatAmount(priorAmount, row.decimals) : null, formattedAfter: decimalValid && nextAmount !== null ? formatAmount(nextAmount, row.decimals) : null, formattedDelta: decimalValid && delta !== null ? formatAmount(delta, row.decimals) : null };
  });
  const beforeSOL = integerOrNull(a.solLamports), afterSOL = integerOrNull(b.solLamports);
  const solDelta = beforeSOL !== null && afterSOL !== null ? (exactInteger(afterSOL) - exactInteger(beforeSOL)).toString() : null;
  const exact = solDelta !== null && changes.every(row => row.delta !== null && row.decimals !== null);
  const observedAt = new Date().toISOString();
  return {
    kind: 'comparison', summary: { network: b.network, input: b.owner, owner: b.owner, taskStatus: 'completed', complete, interval: { from: start, to: end, durationMs: Date.parse(end) - Date.parse(start), sameObservation }, slotRange: { previous: a.slotRange || a.slot, current: b.slotRange || b.slot }, solChange: { before: beforeSOL, after: afterSOL, delta: solDelta, formattedDelta: solDelta !== null ? formatAmount(solDelta, 9) : null }, changes, scope: SCOPE, derivedLocally: true, explorerUrl: explorerUrl('snapshot', b.owner, b.network) },
    checks: [
      check('snapshot-identity', 'Snapshot identity matches', 'pass', 'Both snapshots belong to the same account and network.', 'previous.owner/network compared with current.owner/network'),
      check('snapshot-time-range', 'Snapshot observation interval', sameObservation ? 'unknown' : 'pass', sameObservation ? 'Both captures have the same source observation time; they may refer to the same cached read.' : `The recorded interval is ${start} to ${end}.`, 'previous.observedAt; current.observedAt', 'No balance at an arbitrary historical time is inferred.'),
      check('snapshot-scope', 'Comparable snapshot coverage', complete ? 'pass' : 'unknown', complete ? 'Both captures covered the returned public SOL and Token account scope.' : 'One or both captures are partial. Missing balances are unknown.', 'previous.complete; current.complete; snapshot scope and errors', SCOPE),
      check('snapshot-deltas', 'Exact recorded balance differences', exact ? 'pass' : 'unknown', exact ? 'Balance differences were computed with exact integer subtraction.' : 'Some differences are unknown because a required amount or decimals was unavailable.', 'Recorded lamport and per-Mint/program amounts', 'Snapshot differences are changes in recorded balances, not trading profit or investment returns.'),
    ],
    raw: { previous: a, current: b }, evidenceRefs: [...(previous.evidenceRefs || []), ...(current.evidenceRefs || [])], observedAt, dataSource: 'Local comparison of saved RPC observations',
  };
}
