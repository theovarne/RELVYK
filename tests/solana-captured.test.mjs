import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseJSONExact } from '../src/solana/precision.js';
import { normalizeTransaction } from '../src/solana/transaction.js';
import { normalizeToken } from '../src/solana/token.js';

// Real read-only responses captured by the task's public network verification.
// These tests replay captured data and do not make fresh RPC calls.
const directory = new URL('./fixtures/solana/', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('provenance.json', directory), 'utf8'));
function captured(file) {
  const record = manifest.records.find(record => record.file === file);
  const response = parseJSONExact(fs.readFileSync(new URL(file, directory), 'utf8'));
  return { result: response.result, observedAt: record.capturedAt, dataSource: `Captured public ${record.network} RPC response`, cache: { hit: false, ageMs: 0 } };
}

test('captured real legacy transaction resolves accounts, instructions, fees and exact balance fields', () => {
  const read = captured('token-tx-0.json');
  const signature = '5TWqTummkCyctggBmFHd7XoVts4ntHDdQoz34nNh8EAq1YHiQZduRuBsjZCdfN9L7W4WtwWS3KfoeGyzgs5SfPJS';
  const result = normalizeTransaction(signature, 'devnet', read);
  assert.equal(result.summary.version, 'legacy');
  assert.equal(result.summary.chainStatus, 'succeeded');
  assert.equal(result.summary.feeLamports, '10700');
  assert.ok(result.summary.instructions.some(instruction => instruction.level === 'inner'));
  assert.equal(result.checks.find(check => check.id === 'account-indexes').status, 'pass');
  assert.equal(result.checks.find(check => check.id === 'sol-integers').status, 'pass');
  assert.equal(result.checks.find(check => check.id === 'finality').status, 'unknown');
});
test('captured real version 0 jsonParsed transaction resolves the supplied account key order', () => {
  const read = captured('token2022-tx-1.json');
  const signature = '2f8FEwP4Qp6puyCmo4e1edawWFy3rrxkeW6JiVCjTiqxv7oKTGDbJajy73TGBPZvJ2UuQC8YkGVQANVxzb9iamcz';
  const result = normalizeTransaction(signature, 'devnet', read);
  assert.equal(result.summary.version, 0);
  assert.equal(result.summary.accounts.length, read.result.transaction.message.accountKeys.length);
  assert.equal(result.checks.find(check => check.id === 'account-indexes').status, 'pass');
  assert.equal(result.summary.instructions.length, 2);
});
test('captured real original Mint includes its exact supply, and captured rentEpoch remains lossless', () => {
  const read = captured('token-mint-0-0.json');
  const result = normalizeToken('Aj1qyqJRvi7VFdCriNvLiiCvjkLW3pTRgFCKSyGtAbsk', 'devnet', read);
  assert.equal(result.summary.isMint, true);
  assert.equal(result.summary.supplyRaw, '1501030000000000');
  assert.equal(result.summary.decimals, 6);
  assert.equal(result.raw.account.value.rentEpoch, '18446744073709551615');
});
test('captured real Token-2022 Mint shows actual parsed extensions and limits binary coverage honestly', () => {
  const read = captured('token2022-mint-0-0.json');
  const result = normalizeToken('7mqdwH6yrbUZcx4jKomAYG2A6mEnuf4hdH5yt4XM14gv', 'devnet', read);
  assert.equal(result.summary.isMint, true);
  assert.equal(result.summary.supply, '746923531.964144523');
  assert.deepEqual(result.summary.extensions.map(extension => extension.name), ['metadataPointer', 'mintCloseAuthority', 'tokenMetadata']);
  assert.equal(result.summary.metadata.fetchedExternal, false);
  assert.equal(result.checks.find(check => check.id === 'token-extensions').status, 'unknown');
});
test('captured real Token-2022 binary Mint inventory agrees with parsed controls and retains actual context slots', () => {
  const parsed = captured('token2022-mint-0-0.json'), binary = captured('token2022-binary.json');
  const result = normalizeToken('7mqdwH6yrbUZcx4jKomAYG2A6mEnuf4hdH5yt4XM14gv', 'devnet', parsed, binary);
  assert.deepEqual(result.summary.extensionTypes.map(extension => extension.typeId), [18, 3, 19]);
  assert.deepEqual(result.summary.extensionTypes.map(extension => extension.byteLength), [64, 32, 149]);
  assert.equal(result.summary.extensionCoverage, true);
  assert.equal(result.checks.find(check => check.id === 'mint-core-consistency').status, 'pass');
  assert.equal(result.summary.contextSlots.parsed, String(parsed.result.context.slot));
  assert.equal(result.summary.contextSlots.binary, String(binary.result.context.slot));
  assert.match(result.checks.find(check => check.id === 'token-extensions').limitation, /does not verify/);
});
test('captured real mainnet version 1 chain failure completes inspection with signed resource evidence intact', () => {
  const read = captured('mainnet-v1-failed.json');
  const signature = '2iKX75nDizwkSm6FbZMJdBV226fTreHQwAfK1MyJyAjv6mnP9ekAsdpnqMsKMf5ytv2bshGbbWHQTuZU4SoVb1Ld';
  const result = normalizeTransaction(signature, 'mainnet-beta', read);
  assert.equal(result.summary.version, 1);
  assert.equal(result.summary.taskStatus, 'completed');
  assert.equal(result.summary.chainStatus, 'failed');
  assert.deepEqual(result.summary.error, { InstructionError: [0, { Custom: 12 }] });
  assert.equal(result.summary.transactionConfig.priorityFee, '1');
  assert.equal(result.summary.transactionConfig.priorityFeeSOL, '0.000000001');
  assert.equal(result.summary.transactionConfig.computeUnitLimit, '151733');
  assert.equal(result.summary.transactionConfig.loadedAccountsDataSizeLimit, '16776667');
  assert.equal(result.summary.transactionConfig.fieldStates.heapSize, 'unset');
  assert.equal(result.summary.transactionConfig.noAddressLookupTables, true);
  assert.deepEqual(result.summary.transactionConfig.raw, read.result.transaction.message.transactionConfig);
  assert.deepEqual(result.raw.transaction, read.result);
  assert.equal(result.checks.find(check => check.id === 'account-indexes').status, 'pass');
  assert.equal(result.checks.find(check => check.id === 'transaction-config').status, 'pass');
});
