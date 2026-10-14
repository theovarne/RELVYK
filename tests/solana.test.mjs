import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJSONExact, exactInteger, formatAmount } from '../src/solana/precision.js';
import { validateInput, validateRpcRequest, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from '../src/solana/validation.js';
import { normalizeTransaction } from '../src/solana/transaction.js';
import { normalizeToken, readBinaryMint } from '../src/solana/token.js';
import { normalizeSnapshot, compareSnapshots } from '../src/solana/snapshot.js';
import { rpc } from '../src/solana/transport.js';

// All fixtures in this file are deliberately synthetic unit-test inputs.
// No fixture is shown as a live query, project Mint, or evidence of a chain event.
const SIGNATURE = '1'.repeat(64);
const OWNER = '11111111111111111111111111111111';
const MINT = 'So11111111111111111111111111111111111111112';
const SECOND_ACCOUNT = TOKEN_PROGRAM;
const THIRD_ACCOUNT = TOKEN_2022_PROGRAM;
const TIME = '2026-10-14T08:00:00.000Z';
const read = result => ({ result, observedAt: TIME, dataSource: 'Explicit synthetic test fixture', cache: { hit: false, ageMs: 0 } });
const status = (confirmationStatus = 'confirmed', err = null) => read({ context: { slot: 100 }, value: [{ slot: 99, confirmationStatus, err }] });
const findCheck = (result, id) => result.checks.find(check => check.id === id);

function transaction({ error = null, parsed = false } = {}) {
  return {
    slot: 99, blockTime: 1760400000, version: 0,
    transaction: { signatures: [SIGNATURE], message: {
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
      accountKeys: parsed ? [{ pubkey: OWNER, signer: true, writable: true, source: 'transaction' }, { pubkey: TOKEN_PROGRAM, signer: false, writable: false, source: 'transaction' }, { pubkey: MINT, signer: false, writable: true, source: 'lookupTable' }] : [OWNER, TOKEN_PROGRAM],
      instructions: [{ programIdIndex: 1, accounts: [0, 2], data: '2' }],
    } },
    meta: { err: error, fee: 5000, preBalances: ['9007199254740993', 1, 0], postBalances: ['9007199254745993', 1, 100], loadedAddresses: { writable: [MINT], readonly: [] },
      innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [2], data: '3' }] }],
      preTokenBalances: [{ accountIndex: 2, mint: MINT, owner: OWNER, programId: TOKEN_PROGRAM, uiTokenAmount: { amount: '9007199254740993', decimals: 6 } }],
      postTokenBalances: [{ accountIndex: 2, mint: MINT, owner: OWNER, programId: TOKEN_PROGRAM, uiTokenAmount: { amount: '9007199254741993', decimals: 6 } }], logMessages: ['Synthetic fixture log'],
    },
  };
}
const mintAccount = (info = {}, program = TOKEN_PROGRAM) => read({ context: { slot: 100 }, value: { owner: program, executable: false, data: { parsed: { type: 'mint', info: { supply: '18446744073709551615', decimals: 6, isInitialized: true, mintAuthority: null, freezeAuthority: null, ...info } }, space: 82 } } });
function binaryMint({ extensionId = null } = {}) {
  const bytes = Buffer.alloc(extensionId === null ? 82 : 172);
  bytes.writeBigUInt64LE(18446744073709551615n, 36); bytes[44] = 6; bytes[45] = 1;
  if (extensionId !== null) { bytes[165] = 1; bytes.writeUInt16LE(extensionId, 166); bytes.writeUInt16LE(2, 168); bytes[170] = 1; bytes[171] = 2; }
  return { owner: TOKEN_2022_PROGRAM, executable: false, data: [bytes.toString('base64'), 'base64'] };
}
function tokenAccount(address, amount, program = TOKEN_PROGRAM) {
  return { pubkey: address, account: { owner: program, data: { parsed: { type: 'account', info: { owner: OWNER, mint: MINT, tokenAmount: { amount, decimals: 6 }, state: 'initialized' } } } } };
}
function snapshotReads(original = [], token2022 = []) {
  return { sol: read({ context: { slot: 100 }, value: '9007199254740993' }), original: read({ context: { slot: 101 }, value: original }), token2022: read({ context: { slot: 102 }, value: token2022 }) };
}

test('validates decoded base58 length, alphabet, and task type instead of text length', () => {
  assert.equal(validateInput('transaction', SIGNATURE).valid, true);
  assert.equal(validateInput('transaction', '1'.repeat(63)).valid, false);
  assert.equal(validateInput('token', MINT).valid, true);
  assert.equal(validateInput('snapshot', '1'.repeat(31)).valid, false);
  assert.equal(validateInput('token', 'I'.repeat(44)).valid, false);
  assert.equal(validateInput('random', MINT).valid, false);
});
test('preserves unsafe integers before parsing, including scientific integer syntax', () => {
  const data = parseJSONExact('{"balance":9007199254740993,"rentEpoch":18446744073709551615,"negative":-9007199254740993,"exponent":9.007199254740993e15,"text":"9007199254740993 \\"quoted\\"","index":2,"fraction":0.2}');
  assert.equal(data.balance, '9007199254740993');
  assert.equal(data.rentEpoch, '18446744073709551615');
  assert.equal(data.negative, '-9007199254740993');
  assert.equal(data.exponent, '9007199254740993');
  assert.equal(data.index, 2); assert.equal(data.fraction, 0.2);
  assert.throws(() => exactInteger(9007199254740992), /Unsafe/);
  assert.equal(formatAmount('18446744073709551615', 9), '18446744073.709551615');
  assert.equal(formatAmount('-2', 6), '-0.000002');
});
test('resolves version 0 loaded keys for top and inner instructions with exact deltas', () => {
  const result = normalizeTransaction(SIGNATURE, 'devnet', read(transaction()), status());
  assert.equal(result.summary.accounts.length, 3);
  assert.equal(result.summary.instructions[0].accounts[1], MINT);
  assert.equal(result.summary.instructions[1].accounts[0], MINT);
  assert.equal(result.summary.instructions[1].parentIndex, 0);
  assert.equal(result.summary.balanceChanges.sol[0].delta, '5000');
  assert.equal(result.summary.balanceChanges.tokens[0].delta, '1000');
  assert.equal(result.summary.balanceChanges.tokens[0].formattedDelta, '0.001');
  assert.equal(findCheck(result, 'account-indexes').status, 'pass');
  assert.equal(result.summary.instructions[0].type, 'Unparsed instruction');
  assert.match(result.summary.balanceChanges.limitation, /not a buy\/sell/);
});
test('never duplicates lookup accounts already expanded by jsonParsed', () => {
  const result = normalizeTransaction(SIGNATURE, 'devnet', read(transaction({ parsed: true })), status('finalized'));
  assert.equal(result.summary.accounts.length, 3);
  assert.equal(result.summary.finality, 'finalized');
});
test('successful inspection of a failed chain transaction keeps chain outcome and finality separate', () => {
  const error = { InstructionError: [0, 'Custom'] };
  const result = normalizeTransaction(SIGNATURE, 'devnet', read(transaction({ error })), status('confirmed', error));
  assert.equal(result.summary.taskStatus, 'completed');
  assert.equal(result.summary.chainStatus, 'failed');
  assert.equal(result.summary.finality, 'confirmed');
  assert.deepEqual(result.summary.error, error);
  assert.equal(findCheck(result, 'chain-outcome').status, 'pass');
});
test('missing Token balance arrays and finality evidence remain unknown', () => {
  const fixture = transaction(); delete fixture.meta.preTokenBalances; delete fixture.meta.postTokenBalances;
  const result = normalizeTransaction(SIGNATURE, 'devnet', read(fixture), null, 'Synthetic provider failure');
  assert.equal(findCheck(result, 'token-balances').status, 'unknown');
  assert.equal(findCheck(result, 'finality').status, 'unknown');
  assert.equal(result.summary.finality, 'confirmed');
  assert.equal(result.summary.balanceChanges.tokensAvailable, false);
});
test('optional missing Token program fields do not split one account into fabricated incoming and outgoing changes', () => {
  const fixture = transaction(); delete fixture.meta.preTokenBalances[0].programId;
  const result = normalizeTransaction(SIGNATURE, 'devnet', read(fixture), status());
  assert.equal(result.summary.balanceChanges.tokens.length, 1);
  assert.equal(result.summary.balanceChanges.tokens[0].program, TOKEN_PROGRAM);
  assert.equal(result.summary.balanceChanges.tokens[0].delta, '1000');
});
test('missing signature outcome or finality fields remain unknown, including null transaction reads', () => {
  const missing = read({ value: [{ slot: 100 }] });
  assert.equal(normalizeTransaction(SIGNATURE, 'devnet', read(null), missing).summary.chainStatus, 'unknown');
  assert.equal(findCheck(normalizeTransaction(SIGNATURE, 'devnet', read(transaction()), missing), 'finality').status, 'unknown');
});
test('null transaction evidence does not claim historical inexistence, and future versions fail explicitly', () => {
  const result = normalizeTransaction(SIGNATURE, 'testnet', read(null));
  assert.equal(result.summary.taskStatus, 'incomplete');
  assert.equal(result.summary.chainStatus, 'unknown');
  assert.match(result.checks[0].limitation, /does not prove/);
  const future = transaction(); future.version = 2;
  assert.throws(() => normalizeTransaction(SIGNATURE, 'testnet', read(future)), error => error.code === 'UNSUPPORTED_VERSION');
});
test('version 1 preserves exact total priority fee and reads budgets from signed configuration', () => {
  const fixture = transaction({ parsed: true }); fixture.version = 1;
  fixture.transaction.message.accountKeys[2].source = 'transaction';
  fixture.meta.loadedAddresses = { writable: [], readonly: [] };
  fixture.transaction.message.transactionConfig = { computeUnitLimit: 30000, heapSize: null, loadedAccountsDataSizeLimit: 200000, priorityFee: '9007199254740993' };
  const result = normalizeTransaction(SIGNATURE, 'devnet', read(fixture), status());
  assert.equal(result.summary.version, 1);
  assert.equal(result.summary.transactionConfig.priorityFee, '9007199254740993');
  assert.equal(result.summary.transactionConfig.priorityFeeSOL, '9007199.254740993');
  assert.equal(result.summary.transactionConfig.priorityFeeUnit, 'total lamports');
  assert.equal(result.summary.transactionConfig.heapSize, null);
  assert.equal(result.summary.transactionConfig.fieldStates.heapSize, 'unset');
  assert.equal(findCheck(result, 'transaction-config').status, 'pass');
  assert.deepEqual(result.summary.transactionConfig.raw, fixture.transaction.message.transactionConfig);
  assert.match(result.summary.transactionConfig.limitation, /ComputeBudget instructions do not set/);
});
test('version 1 missing configuration stays unknown and unexpected lookup addresses are never appended', () => {
  const fixture = transaction(); fixture.version = 1;
  const result = normalizeTransaction(SIGNATURE, 'devnet', read(fixture));
  assert.equal(result.summary.accounts.length, 2);
  assert.equal(result.summary.transactionConfig.present, false);
  assert.equal(result.summary.transactionConfig.fieldStates.computeUnitLimit, 'unknown');
  assert.equal(findCheck(result, 'transaction-config').status, 'unknown');
  assert.equal(findCheck(result, 'account-indexes').status, 'unknown');
});
test('version 1 explicit unset required budget is a finding, not an invented legacy default', () => {
  const fixture = transaction({ parsed: true }); fixture.version = 1;
  fixture.transaction.message.accountKeys[2].source = 'transaction'; fixture.meta.loadedAddresses = { writable: [], readonly: [] };
  fixture.transaction.message.transactionConfig = { computeUnitLimit: null, heapSize: null, loadedAccountsDataSizeLimit: 200000, priorityFee: null };
  const result = normalizeTransaction(SIGNATURE, 'devnet', read(fixture));
  assert.equal(findCheck(result, 'transaction-config').status, 'fail');
  assert.equal(result.summary.transactionConfig.computeUnitLimit, null);
  assert.equal(result.summary.transactionConfig.priorityFee, null);
});
test('Mint inspection preserves supply and distinguishes revoked, present, and unknown authority', () => {
  const result = normalizeToken(MINT, 'devnet', mintAccount({ mintAuthority: OWNER }));
  assert.equal(result.summary.supply, '18446744073709.551615');
  assert.deepEqual(result.summary.mintAuthority, { state: 'present', address: OWNER });
  assert.equal(result.summary.freezeAuthority.state, 'revoked');
  const fixture = mintAccount(); delete fixture.result.value.data.parsed.info.mintAuthority;
  const missing = normalizeToken(MINT, 'devnet', fixture);
  assert.equal(missing.summary.mintAuthority.state, 'unknown');
  assert.equal(findCheck(missing, 'mint-authority').status, 'unknown');
});
test('wallets and Token accounts are not silently accepted as Mints', () => {
  const wallet = read({ context: { slot: 1 }, value: { owner: OWNER, executable: false, data: { parsed: { type: 'mint', info: {} } } } });
  assert.equal(normalizeToken(MINT, 'devnet', wallet).summary.isMint, false);
  const account = mintAccount(); account.result.value.data.parsed.type = 'account';
  const result = normalizeToken(MINT, 'devnet', account);
  assert.equal(result.summary.isMint, false);
  assert.equal(findCheck(result, 'mint-type').status, 'fail');
  assert.equal(result.summary.supply, null);
});
test('Token-2022 retains unknown binary extension IDs and cannot claim complete extension coverage', () => {
  const binary = binaryMint({ extensionId: 65000 });
  const parsed = mintAccount({ extensions: [] }, TOKEN_2022_PROGRAM);
  const result = normalizeToken(MINT, 'devnet', parsed, read({ context: { slot: 101 }, value: binary }));
  assert.equal(readBinaryMint(binary).valid, true);
  assert.deepEqual(result.summary.extensionTypes.map(row => row.typeId), [65000]);
  assert.equal(findCheck(result, 'token-extensions').status, 'unknown');
  assert.equal(result.summary.extensionCoverage, false);
  assert.match(findCheck(result, 'token-extensions').limitation, /Unparsed IDs remain visible/);
});
test('on-account metadata is preserved as untrusted text and external URLs are never fetched', () => {
  const result = normalizeToken(MINT, 'devnet', mintAccount({ extensions: [{ extension: 'tokenMetadata', state: { name: '<img src=x onerror=alert(1)>', symbol: 'MOCK', uri: 'http://127.0.0.1/internal' } }] }, TOKEN_2022_PROGRAM));
  assert.equal(result.summary.metadata.name, '<img src=x onerror=alert(1)>');
  assert.equal(result.summary.metadata.fetchedExternal, false);
  assert.equal(findCheck(result, 'token-extensions').status, 'unknown');
});
test('snapshot sums owned Token accounts exactly and keeps programs separate for the same Mint', () => {
  const result = normalizeSnapshot(OWNER, 'devnet', snapshotReads([tokenAccount(SECOND_ACCOUNT, '9007199254740993'), tokenAccount(MINT, '7')], [tokenAccount(THIRD_ACCOUNT, '11', TOKEN_2022_PROGRAM)]));
  assert.equal(result.summary.complete, true);
  assert.equal(result.summary.balances.length, 2);
  assert.equal(result.summary.balances.find(row => row.program === TOKEN_PROGRAM).amount, '9007199254741000');
  assert.equal(result.summary.balances.find(row => row.program === TOKEN_2022_PROGRAM).amount, '11');
  assert.equal(result.summary.solLamports, '9007199254740993');
  assert.deepEqual(result.summary.slotRange, { min: '100', max: '102' });
  assert.equal(result.summary.atomic, false);
});
test('partial snapshots preserve missing scope instead of inventing zero balances', () => {
  const prior = normalizeSnapshot(OWNER, 'devnet', snapshotReads([tokenAccount(SECOND_ACCOUNT, '20')]));
  const nextReads = snapshotReads(); nextReads.original = { error: Object.assign(new Error('Synthetic read failure'), { code: 'RPC_TIMEOUT' }) };
  const next = normalizeSnapshot(OWNER, 'devnet', nextReads);
  next.summary.observedAt = '2026-10-14T09:00:00.000Z';
  const result = compareSnapshots(prior, next);
  assert.equal(next.summary.complete, false);
  assert.equal(next.summary.taskStatus, 'incomplete');
  assert.equal(result.summary.changes[0].after, null);
  assert.equal(result.summary.changes[0].delta, null);
  assert.equal(findCheck(result, 'snapshot-scope').status, 'unknown');
});
test('complete recorded snapshots allow missing Mint zero, reject mismatched owner/network, and detect same observation', () => {
  const prior = normalizeSnapshot(OWNER, 'devnet', snapshotReads([tokenAccount(SECOND_ACCOUNT, '20')]));
  const next = normalizeSnapshot(OWNER, 'devnet', snapshotReads());
  assert.equal(compareSnapshots(prior, next).summary.changes[0].delta, '-20');
  assert.equal(findCheck(compareSnapshots(prior, next), 'snapshot-time-range').status, 'unknown');
  assert.throws(() => compareSnapshots(prior, { ...next.summary, network: 'testnet' }), error => error.code === 'COMPARISON_MISMATCH');
  assert.throws(() => compareSnapshots(prior, { ...next.summary, owner: MINT }), error => error.code === 'COMPARISON_MISMATCH');
});
test('duplicate Token accounts never double-count amounts or claim complete scope', () => {
  const fixture = tokenAccount(SECOND_ACCOUNT, '20');
  const result = normalizeSnapshot(OWNER, 'devnet', snapshotReads([fixture, fixture]));
  assert.equal(result.summary.complete, false);
  assert.equal(result.summary.balances[0].amount, '20');
  assert.equal(result.summary.errors[0].code, 'DUPLICATE_ACCOUNT');
});
test('RPC request allowlist rejects broadcasts, arbitrary URLs, unbounded scans, and unsupported versions', () => {
  assert.throws(() => validateRpcRequest('sendTransaction', ['payload'], 'devnet'), /allowlist/);
  assert.throws(() => validateRpcRequest('getBalance', [OWNER, { commitment: 'confirmed' }], 'https://evil.example'), /Choose/);
  assert.throws(() => validateRpcRequest('getSignaturesForAddress', [OWNER, { limit: 1000 }], 'devnet'), /between 1 and 20/);
  assert.doesNotThrow(() => validateRpcRequest('getTransaction', [SIGNATURE, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }], 'devnet'));
  assert.throws(() => validateRpcRequest('getTransaction', [SIGNATURE, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 2 }], 'devnet'), /version ceiling/);
});

test('browser RPC shares reads while cancellation of one subscriber cannot cancel another', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0, finish, upstreamSignal;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/rpc'); requests++; upstreamSignal = options.signal;
    await new Promise(resolve => finish = resolve);
    return new Response(JSON.stringify({ result: { context: { slot: 1 }, value: '9007199254740993' }, observedAt: TIME, dataSource: 'Explicit synthetic test fixture', cache: { hit: false, ageMs: 0 } }), { status: 200 });
  };
  try {
    const controller = new AbortController();
    const a = rpc('getBalance', [OWNER, { commitment: 'confirmed' }], 'devnet', { signal: controller.signal });
    const rejected = assert.rejects(a, error => error.name === 'AbortError');
    const b = rpc('getBalance', [OWNER, { commitment: 'confirmed' }], 'devnet');
    controller.abort(); assert.equal(upstreamSignal.aborted, false); finish();
    assert.equal((await b).value, '9007199254740993'); await rejected; assert.equal(requests, 1);
  } finally { globalThis.fetch = originalFetch; }
});
