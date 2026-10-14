import test from 'node:test';
import assert from 'node:assert/strict';
import { REFLEX_TEMPLATES } from '../src/reflex-library.js';
import { renderDossiers } from '../src/reflex-dossiers.js';
import { renderEvidenceDetail, renderEvidenceList, resolveEvidencePaths } from '../src/evidence-panel.js';

// These are explicit mock DOM tests. They do not claim browser or live RPC use.
class MockNode {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.handlers = new Map(); this.className = ''; this.open = false; this._text = ''; this.classList = { add: value => { this.className += ` ${value}`; }, toggle: (value, active) => { const names = new Set(this.className.split(' ').filter(Boolean)); if (active) names.add(value); else names.delete(value); this.className = [...names].join(' '); } }; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent ?? String(child)).join(''); }
  set innerHTML(_value) { throw new Error('Unsafe HTML insertion'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this._text = ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, callback) { const list = this.handlers.get(type) || []; list.push(callback); this.handlers.set(type, list); }
  focus() { this.focused = true; }
  async emit(type, extra = {}) { const event = { preventDefault() {}, stopPropagation() {}, ...extra }; for (const callback of this.handlers.get(type) || []) await callback(event); await Promise.resolve(); }
}
globalThis.document = { createElement: tag => new MockNode(tag), createElementNS: (_namespace, tag) => new MockNode(tag), getElementById: () => null };
const all = node => [node, ...node.children.flatMap(child => child instanceof MockNode ? all(child) : [])];
const byText = (root, text) => all(root).find(node => node.tag === 'button' && node.textContent === text);
const records = [{ runId: 'record-a', taskType: 'transaction', input: 'stored-input', network: 'devnet', outcome: 'completed', observedAt: '2026-10-14T09:00:00.000Z', completedAt: '2026-10-14T09:00:01.000Z', storageScope: 'local', dataSource: 'Explicit fixture', stepRecords: [{ stage: 'VERIFY', status: 'complete', summary: 'Stored check summary', startedAt: '2026-10-14T09:00:00.000Z', completedAt: '2026-10-14T09:00:01.000Z', evidenceRefs: [] }], checks: [{ id: 'chain-outcome', label: 'Chain outcome', status: 'pass', finding: 'Error was read', evidence: 'meta.err' }], result: { summary: { chainStatus: 'failed', finality: 'confirmed', feeSOL: '0.000005', slot: '9007199254740993', version: 1 }, raw: { transaction: { meta: { err: { Custom: 12 } }, transaction: { message: { instructions: [] } } } }, evidenceRefs: [{ id: 'transaction', method: 'getTransaction' }] } }];

test('dossiers render three distinct diagrams, real supplied counts and executable callbacks', async () => {
  const container = new MockNode('div'), templates = structuredClone(REFLEX_TEMPLATES); templates[0].executionCount = 7;
  let run, copied, opened;
  const controller = renderDossiers(container, templates, { onRun: template => { run = template.id; }, onCopy: template => { copied = template.id; }, getRecords: async () => records, onRecord: record => { opened = record.runId; } });
  assert.equal(all(container).filter(node => node.tag === 'svg').length, 3);
  assert.equal(new Set(all(container).filter(node => node.tag === 'svg').map(node => node.attributes['aria-label'])).size, 3);
  assert.ok(container.textContent.includes('7 recorded runs'));
  await byText(container, 'Run →').emit('click'); assert.equal(run, templates[0].id);
  await byText(container, 'Save Copy').emit('click'); assert.equal(copied, templates[0].id);
  controller.open(templates[0].id, 'checks'); assert.ok(container.textContent.includes('Defined checks'));
  controller.open(templates[0].id, 'records'); await Promise.resolve(); await Promise.resolve();
  const recordButton = all(container).find(node => node.tag === 'button' && node.textContent.includes('completed')); await recordButton.emit('click'); assert.equal(opened, 'record-a');
});
test('dossier stale async record loads cannot replace a newly selected layer', async () => {
  const container = new MockNode('div'); let finish;
  const controller = renderDossiers(container, structuredClone(REFLEX_TEMPLATES), { getRecords: () => new Promise(resolve => { finish = resolve; }) });
  controller.open('inspect-transaction', 'records'); controller.open('inspect-transaction', 'checks'); finish(records); await Promise.resolve();
  assert.ok(container.textContent.includes('Defined checks')); assert.equal(container.textContent.includes('stored-input'), false);
});
test('strict evidence paths resolve actual stored fields while prose and ambiguous matches stay unknown', () => {
  const direct = resolveEvidencePaths(records[0], records[0].checks[0]); assert.equal(direct.fields[0].path, 'result.raw.transaction.meta.err'); assert.deepEqual(direct.fields[0].value, { Custom: 12 });
  const rpc = resolveEvidencePaths(records[0], { evidence: 'getTransaction.result.transaction.message' }); assert.equal(rpc.fields.length, 1);
  assert.equal(resolveEvidencePaths(records[0], { evidence: 'account is safe because it looks good' }).status, 'unknown');
  const ambiguous = structuredClone(records[0]); ambiguous.result.raw.other = { meta: { err: null } };
  assert.equal(resolveEvidencePaths(ambiguous, { evidence: 'meta.err' }).fields.length, 0);
  assert.equal(resolveEvidencePaths(records[0], { evidence: 'constructor.prototype' }).fields.length, 0);
});
test('drawer layers are keyboard accessible and check selection highlights real evidence', async () => {
  const container = new MockNode('div'); let step, replay;
  const controller = renderEvidenceDetail(container, records[0], { onStep: (_record, selected, index) => { step = [selected.stage, index]; }, onReplay: record => { replay = record.runId; } });
  assert.equal(controller.getState().tab, 'summary'); assert.ok(container.textContent.includes('9007199254740993'));
  await byText(container, 'Summary').emit('keydown', { key: 'ArrowRight' }); assert.equal(controller.getState().tab, 'steps');
  await byText(container, '01 / VERIFY').emit('click'); assert.deepEqual(step, ['VERIFY', 0]);
  controller.selectCheck('chain-outcome'); assert.ok(container.textContent.includes('result.raw.transaction.meta.err')); assert.ok(container.textContent.includes('12'));
  await byText(container, 'Replay Recorded Run').emit('click'); assert.equal(replay, 'record-a');
});
test('drawer keeps metadata as text and copies exact JSON only after the explicit action', async () => {
  const record = structuredClone(records[0]), container = new MockNode('div'), malicious = '<img src=x onerror=alert(1)><script>alert(1)</script>'; record.checks[0].finding = malicious; record.input = malicious;
  let copied = null, exported = false;
  const controller = renderEvidenceDetail(container, record, { copyText: text => { copied = text; return true; }, onExport: () => { exported = true; } });
  assert.ok(container.textContent.includes(malicious)); controller.setTab('checks'); assert.ok(container.textContent.includes(malicious));
  assert.equal(all(container).some(node => ['img', 'script', 'iframe'].includes(node.tag)), false);
  controller.setTab('raw'); assert.equal(copied, null); assert.equal(exported, false);
  await byText(container, 'Copy JSON').emit('click'); assert.equal(copied, JSON.stringify(record, null, 2)); assert.equal(exported, false);
});
test('list and timeline use the same supplied records and preserve selected record callback identity', async () => {
  const list = new MockNode('div'), timeline = new MockNode('div'); let opened;
  renderEvidenceList(list, records, { view: 'list', selectedId: 'record-a', onOpen: record => { opened = record; } });
  renderEvidenceList(timeline, records, { view: 'timeline' });
  assert.equal(all(list).filter(node => node.dataset.runId).length, 1); assert.equal(all(timeline).filter(node => node.dataset.runId).length, 1);
  await byText(list, 'Open evidence ↗').emit('click'); assert.equal(opened, records[0]); assert.ok(list.textContent.includes('stored-input'));
});
