import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_PARTS, getModelPresentation, getVerificationPresentation, createModelController } from '../src/model-controller.js';
import { getBlueprintPresentation } from '../src/engine-blueprint.js';

test('existing six SVG organs map to the six task stages exactly once', () => {
  assert.deepEqual(MODEL_PARTS.map(part => `${part.organ}:${part.stage}`), [
    'eyes:SENSE', 'brain:PLAN', 'immune:AUTHORIZE', 'hands:EXECUTE', 'heart:VERIFY', 'memory:REMEMBER',
  ]);
});

test('idle mechanical study never reports an executing task', () => {
  const view = getModelPresentation({ status: 'idle', stage: 'INPUT', runId: null });
  assert.equal(view.caption, 'Idle mechanical study');
  assert.equal(view.processing, false);
  assert.equal(view.activeStage, null);
});

test('user-selected part and real processing part remain independent', () => {
  const view = getModelPresentation({ status: 'running', runId: 'real-read', stage: 'EXECUTE',
    stepRecords: [{ stage: 'EXECUTE', summary: 'Reading getTransaction from Devnet.' }] }, 'VERIFY');
  assert.equal(view.selectedOrgan, 'heart');
  assert.equal(view.activeOrgan, 'hands');
  assert.equal(view.processing, true);
  assert.match(view.readout, /^VERIFY/);
  assert.equal(getModelPresentation({ stage: 'EXECUTE', stepRecords: [{ stage: 'EXECUTE', summary: 'Reading actual RPC result.' }] }, 'EXECUTE').duty, 'Reading actual RPC result.');
});

test('saved record replay remains labelled historical after reaching its last step', () => {
  const view = getModelPresentation({ status: 'complete', runId: 'saved-run', mode: 'replay', stage: 'REMEMBER' }, 'REMEMBER');
  assert.equal(view.caption, 'Historical replay · saved evidence');
  assert.equal(view.processing, false);
  assert.equal(view.replay, true);
});

test('completed parsing with missing source data retains a limited-data caption', () => {
  const view = getModelPresentation({ status: 'complete', runId: 'limited-read', stage: 'REMEMBER',
    result: { summary: { taskStatus: 'incomplete' } }, record: { storageScope: 'local', outcome: 'incomplete' } });
  assert.equal(view.caption, 'Read completed · limited data · local record');
  assert.equal(view.processing, false);
});

test('memory records and their replay never claim persistent browser storage', () => {
  const state = { status: 'complete', runId: 'session-read', stage: 'REMEMBER', record: { storageScope: 'memory' } };
  assert.equal(getModelPresentation(state).caption, 'Query complete · page session record');
  assert.equal(getModelPresentation({ ...state, mode: 'replay' }).caption, 'Historical replay · page session record');
  assert.equal(getModelPresentation({ ...state, mode: 'replay', record: { storageScope: 'memory', outcome: 'incomplete' } }).caption,
    'Historical replay · limited data · page session record');
});

test('model selection and assembly controls do not mutate the supplied task state', () => {
  const callbacks = [];
  const controller = createModelController({ root: null, windowTarget: null, documentTarget: null, onSelect: stage => callbacks.push(stage) });
  const state = Object.freeze({ status: 'running', runId: 'read', stage: 'EXECUTE', mode: 'query', stepRecords: [] });
  controller.setTaskState(state);
  controller.select('VERIFY');
  controller.explode(true);
  controller.reset();
  assert.deepEqual(callbacks, ['VERIFY', 'EXECUTE']);
  assert.equal(state.stage, 'EXECUTE');
  assert.equal(state.status, 'running');
  controller.destroy();
});

test('continuous model view controls preserve manual selection across new runs and separate hover', () => {
  const selected = [], hovered = [];
  const controller = createModelController({ root: null, windowTarget: null, documentTarget: null, onSelect: stage => selected.push(stage), onHover: stage => hovered.push(stage) });
  controller.setTaskState({ status: 'running', runId: 'first', stage: 'EXECUTE', mode: 'query', stepRecords: [] });
  controller.select('VERIFY'); controller.hover('PLAN');
  assert.equal(controller.getViewState().selectedStage, 'VERIFY');
  assert.equal(controller.getViewState().hoveredStage, 'PLAN');
  assert.deepEqual(selected, ['VERIFY']);
  controller.hover(null);
  controller.setTaskState({ status: 'running', runId: 'next', stage: 'SENSE', mode: 'query', stepRecords: [] });
  assert.equal(controller.getViewState().selectedStage, 'VERIFY');
  assert.equal(controller.getViewState().presentation.activeStage, 'SENSE');
  controller.setView('exploded'); controller.setExplodeAmount(.35);
  assert.equal(controller.getViewState().explodeAmount, .35);
  controller.setExplodeAmount(5); assert.equal(controller.getViewState().explodeAmount, 1);
  controller.setView('trace'); assert.equal(controller.getViewState().view, 'trace');
  controller.setExplodeAmount(.7); assert.equal(controller.getViewState().view, 'trace');
  controller.focus(); assert.equal(controller.getViewState().focusedStage, 'VERIFY');
  controller.setFollowTask(true); assert.equal(controller.getViewState().selectedStage, 'SENSE');
  controller.reset(); assert.equal(controller.getViewState().view, 'assembly');
  assert.equal(controller.getViewState().explodeAmount, 0);
  assert.deepEqual(hovered, ['PLAN', null]);
  controller.destroy();
});

test('verification feedback uses actual pass, fail and unknown checks; an empty pending stage is not a pass', () => {
  assert.equal(getVerificationPresentation({}).status, 'pending');
  assert.equal(getVerificationPresentation({ checks: [{ status: 'pass' }] }).status, 'pass');
  assert.equal(getVerificationPresentation({ checks: [{ status: 'pass' }, { status: 'unknown' }] }).status, 'unknown');
  assert.equal(getVerificationPresentation({ checks: [{ status: 'fail' }, { status: 'unknown' }] }).status, 'fail');
  assert.equal(getVerificationPresentation({ stepRecords: [{ stage: 'VERIFY', status: 'complete' }], checks: [] }).status, 'unknown');
});

test('blueprint follows the same model selection, current phase and replay label without manufacturing task data', () => {
  const controller = createModelController({ root: null, windowTarget: null, documentTarget: null });
  controller.setTaskState({ status: 'running', runId: 'read', stage: 'EXECUTE', mode: 'query', stepRecords: [{ stage: 'SENSE', status: 'complete' }, { stage: 'PLAN', status: 'complete' }, { stage: 'AUTHORIZE', status: 'complete' }, { stage: 'EXECUTE', status: 'running' }] });
  controller.select('VERIFY'); controller.hover('SENSE');
  const blueprint = getBlueprintPresentation(controller.getViewState());
  assert.equal(blueprint.nodes.length, 6);
  assert.equal(blueprint.links.length, 5);
  assert.equal(blueprint.nodes.find(node => node.selected).stage, 'VERIFY');
  assert.equal(blueprint.nodes.find(node => node.hovered).stage, 'SENSE');
  assert.equal(blueprint.links.filter(link => link.current).length, 1);
  assert.equal(blueprint.links.find(link => link.current).to, 'EXECUTE');
  controller.setTaskState({ status: 'complete', runId: 'saved', stage: 'REMEMBER', mode: 'replay', stepRecords: [] });
  const replay = getBlueprintPresentation(controller.getViewState());
  assert.equal(replay.mode, 'replay');
  assert.equal(replay.links.some(link => link.current), false);
  assert.equal(replay.links.find(link => link.selected).to, 'VERIFY');
  assert.match(replay.caption, /Historical replay/);
  controller.destroy();
});

class MockSVGNode extends EventTarget {
  constructor(tag, attrs = {}, box = null) { super(); this.tag = tag; this.dataset = {}; this.attributes = new Map(); this.children = []; this.box = box; this.textContent = ''; this.classes = new Set(); this.classList = { add: value => this.classes.add(value), toggle: (value, force) => { const enabled = force === undefined ? !this.classes.has(value) : force; if (enabled) this.classes.add(value); else this.classes.delete(value); return enabled; } }; for (const [key, value] of Object.entries(attrs)) this.setAttribute(key, value); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value); if (key === 'class') String(value).split(' ').forEach(token => this.classes.add(token)); }
  getAttribute(key) { return this.attributes.get(key) || null; }
  removeAttribute(key) { this.attributes.delete(key); }
  append(...nodes) { this.children.push(...nodes); }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector) { if (selector === 'svg') return this.tag === 'svg'; if (selector.startsWith('.')) return this.classes.has(selector.slice(1)); const match = selector.match(/^\[([^=\]]+)(?:="([^"]+)")?\]$/); return Boolean(match && this.attributes.has(match[1]) && (!match[2] || this.getAttribute(match[1]) === match[2])); }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBBox() { return this.box || { x: 0, y: 0, width: 0, height: 0 }; }
  focus() { this.dispatchEvent(new Event('focus')); }
}

function mockGeometry(reduced = true) {
  const root = new MockSVGNode('root'), figure = new MockSVGNode('figure', { 'data-machine': '' }), stage = new MockSVGNode('div', { class: 'machine-stage' }), svg = new MockSVGNode('svg', { viewBox: '0 0 760 520' });
  const organs = MODEL_PARTS.map((part, index) => new MockSVGNode('g', { 'data-organ': part.organ, 'data-move': `${index % 2 ? 60 : -50},${index % 2 ? 30 : -20}` }, { x: 40 + (index % 3) * 240, y: 60 + Math.floor(index / 3) * 240, width: 100, height: 80 }));
  svg.append(...organs); stage.append(svg); figure.append(stage); root.append(figure);
  const preference = new EventTarget(); preference.matches = reduced;
  const documentTarget = new EventTarget(); documentTarget.hidden = false;
  const frames = new Map(); let id = 0, observer;
  const windowTarget = { matchMedia: () => preference, requestAnimationFrame: callback => { frames.set(++id, callback); return id; }, cancelAnimationFrame: token => frames.delete(token), IntersectionObserver: class { constructor(callback) { this.callback = callback; observer = this; } observe() {} disconnect() {} } };
  return { root, figure, stage, svg, organs, preference, documentTarget, windowTarget, frames, getObserver: () => observer };
}

test('mock geometry: slider moves existing SVG groups, clamps bounds and focus/reset changes only the 2D viewBox', () => {
  const fixture = mockGeometry();
  const controller = createModelController(fixture);
  const task = Object.freeze({ status: 'running', stage: 'EXECUTE', mode: 'query', runId: 'read', stepRecords: [] });
  controller.setTaskState(task); controller.setExplodeAmount(.5);
  const halfway = fixture.organs[1].getAttribute('transform');
  controller.setExplodeAmount(1);
  assert.notEqual(fixture.organs[1].getAttribute('transform'), halfway);
  for (const node of fixture.organs) {
    const [x, y] = node.getAttribute('transform').match(/-?\d+(?:\.\d+)?/g).map(Number);
    assert.ok(node.box.x + x >= 16); assert.ok(node.box.y + y >= 16);
    assert.ok(node.box.x + node.box.width + x <= 744); assert.ok(node.box.y + node.box.height + y <= 504);
  }
  controller.focus('VERIFY');
  assert.ok(Number(fixture.svg.getAttribute('viewBox').split(' ')[2]) < 760);
  assert.equal(controller.getViewState().focusedStage, 'VERIFY');
  controller.reset();
  assert.equal(fixture.svg.getAttribute('viewBox'), '0.00 0.00 760.00 520.00');
  assert.ok(fixture.organs.every(node => node.getAttribute('transform') === 'translate(0.00 0.00)'));
  assert.equal(task.stage, 'EXECUTE');
  controller.destroy();
});

test('mock lifecycle: hidden, offscreen and reduced-motion states stop unnecessary frames and controls still work', () => {
  const fixture = mockGeometry(false);
  const controller = createModelController(fixture);
  assert.equal(fixture.frames.size, 1);
  fixture.getObserver().callback([{ target: fixture.figure, isIntersecting: false }]);
  assert.equal(fixture.frames.size, 0);
  controller.setExplodeAmount(.45);
  assert.equal(controller.getViewState().explodeAmount, .45);
  assert.equal(fixture.frames.size, 0);
  fixture.getObserver().callback([{ target: fixture.figure, isIntersecting: true }]);
  assert.equal(fixture.frames.size, 1);
  fixture.documentTarget.hidden = true; fixture.documentTarget.dispatchEvent(new Event('visibilitychange'));
  assert.equal(fixture.frames.size, 0);
  fixture.documentTarget.hidden = false; fixture.documentTarget.dispatchEvent(new Event('visibilitychange'));
  fixture.preference.matches = true; fixture.preference.dispatchEvent(new Event('change'));
  assert.equal(fixture.frames.size, 0);
  controller.focus('PLAN'); assert.equal(controller.getViewState().focusedStage, 'PLAN');
  controller.destroy();
  assert.equal(fixture.frames.size, 0);
});
