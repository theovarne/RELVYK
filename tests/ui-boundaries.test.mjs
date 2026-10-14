import test from 'node:test';
import assert from 'node:assert/strict';
import { safeExplorerURL, safeJSON, utc } from '../src/ui-helpers.js';

test('saved evidence cannot inject an external or executable explorer link', () => {
  for (const url of ['javascript:alert(1)', 'https://explorer.solana.com.evil.test/tx/11111111111111111111111111111111', 'https://user:secret@explorer.solana.com/address/11111111111111111111111111111111', 'https://explorer.solana.com/address/11111111111111111111111111111111?cluster=custom&customUrl=http://localhost', 'https://explorer.solana.com/address/11111111111111111111111111111111#payload', 'https://explorer.solana.com:444/address/11111111111111111111111111111111', 'https://explorer.solana.com/tx/11111111111111111111111111111111?cluster=devnet&cluster=testnet']) assert.equal(safeExplorerURL(url), null);
  assert.equal(safeExplorerURL('https://explorer.solana.com/address/11111111111111111111111111111111?cluster=devnet'), 'https://explorer.solana.com/address/11111111111111111111111111111111?cluster=devnet');
  assert.equal(safeExplorerURL(null), null);
});

test('exports retain exact integers and hostile metadata as inert JSON text', () => {
  const original = { lamports: 900719925474099312345n, name: '<script>never run</script>' };
  const parsed = JSON.parse(safeJSON(original));
  assert.equal(parsed.lamports, '900719925474099312345');
  assert.equal(parsed.name, original.name);
});

test('UTC dates are explicit and invalid dates remain unavailable', () => {
  assert.equal(utc('2026-10-14T13:00:00+08:00'), '2026-10-14 05:00:00 UTC');
  assert.equal(utc(null), 'Not returned');
  assert.equal(utc('invalid'), 'Not returned');
});
