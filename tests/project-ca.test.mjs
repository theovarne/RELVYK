import test from 'node:test';
import assert from 'node:assert/strict';
import { mountProjectCA } from '../src/project-ca.js';

function fixture() {
  const label = { textContent: '' }, code = { textContent: '' }, status = { textContent: '' };
  const button = new EventTarget();
  button.disabled = false; button.attributes = new Map(); button.dataset = {};
  button.setAttribute = (name, value) => button.attributes.set(name, value);
  button.querySelector = () => label;
  const nodes = { '#project-ca-address': code, '#project-ca-copy': button, '#project-ca-status': status };
  const timers = new Map(); let id = 0;
  return { code, status, label, button, timers, root: { querySelector: selector => nodes[selector] || null }, setTimer: (callback, delay) => { timers.set(++id, { callback, delay }); return id; }, clearTimer: timer => timers.delete(timer), click: () => button.dispatchEvent(new Event('click')), tick: () => { for (const [key, timer] of timers) { timers.delete(key); timer.callback(); } } };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('an unconfigured project has an honest pending address and cannot copy', async () => {
  const f = fixture(); let writes = 0;
  const component = mountProjectCA({ ...f, address: null, clipboard: { writeText: async () => { writes++; } } });
  assert.equal(f.code.textContent, 'Official address pending');
  assert.equal(f.button.disabled, true);
  f.click(); await flush();
  assert.equal(writes, 0); assert.equal(f.label.textContent, 'Copy CA');
  component.destroy();
});

test('copies the full trimmed configured value once and confirms only after the actual clipboard promise', async () => {
  const f = fixture(); const writes = []; let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  const address = 'configured-project-address';
  const component = mountProjectCA({ ...f, address: `  ${address}  `, clipboard: { writeText: value => { writes.push(value); return pending; } } });
  assert.equal(f.code.textContent, address);
  f.click(); f.click();
  assert.deepEqual(writes, [address]); assert.equal(f.button.disabled, true);
  assert.equal(f.button.dataset.copyState, 'busy');
  assert.notEqual(f.label.textContent, 'Copied');
  complete(); await flush();
  assert.equal(f.label.textContent, 'Copied'); assert.equal(f.status.textContent, 'Copied');
  assert.equal(f.button.dataset.copyState, 'success');
  assert.equal(f.button.disabled, false); assert.equal([...f.timers.values()][0].delay, 2500);
  f.tick(); assert.equal(f.label.textContent, 'Copy CA'); assert.equal(f.button.dataset.copyState, 'idle');
  component.destroy();
});

test('clipboard failure preserves the selectable address and gives direct-copy guidance', async () => {
  const f = fixture();
  const component = mountProjectCA({ ...f, address: 'configured-project-address', clipboard: { writeText: async () => { throw new Error('Denied'); } } });
  f.click(); await flush();
  assert.equal(f.code.textContent, 'configured-project-address');
  assert.equal(f.label.textContent, 'Copy failed');
  assert.equal(f.status.textContent, 'Select and copy the address directly');
  assert.equal(f.button.dataset.copyState, 'error');
  f.tick(); assert.equal(f.label.textContent, 'Copy CA');
  component.destroy();
});

test('destroy removes the listener, clears restoration and blocks late asynchronous UI changes', async () => {
  const f = fixture(); let complete; let writes = 0;
  const pending = new Promise(resolve => { complete = resolve; });
  const component = mountProjectCA({ ...f, address: 'configured-project-address', clipboard: { writeText: () => { writes++; return pending; } } });
  f.click(); component.destroy(); complete(); await flush();
  assert.equal(f.label.textContent, 'Copying…'); assert.equal(f.timers.size, 0);
  f.click(); assert.equal(writes, 1);
  const other = fixture();
  const mounted = mountProjectCA({ ...other, address: 'configured-project-address', clipboard: { writeText: async () => {} } });
  other.click(); await flush(); assert.equal(other.timers.size, 1);
  mounted.destroy(); assert.equal(other.timers.size, 0);
});
