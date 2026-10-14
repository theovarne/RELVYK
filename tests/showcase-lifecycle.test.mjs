import test from 'node:test';
import assert from 'node:assert/strict';
import { createShowcaseLifecycle, createShowcaseVisibilityBridge } from '../src/showcase-lifecycle.js';

// Explicit mock visibility/media/window surfaces; no real browser is claimed.
function surface(extra = {}) {
  const handlers = new Map();
  return { ...extra, addEventListener(type, callback) { const set = handlers.get(type) || new Set(); set.add(callback); handlers.set(type, set); }, removeEventListener(type, callback) { handlers.get(type)?.delete(callback); }, emit(type, event = {}) { for (const callback of handlers.get(type) || []) callback(event); } };
}
function fixture() {
  const messages = [], parent = { postMessage: (data, origin) => messages.push({ data, origin }) };
  const documentTarget = surface({ visibilityState: 'visible' }), mediaQuery = surface({ matches: false });
  const windowTarget = surface({ location: { origin: 'https://preview.example' }, parent });
  let callback, disconnected = false;
  const observerFactory = handler => { callback = handler; return { observe() {}, disconnect() { disconnected = true; } }; };
  return { messages, parent, documentTarget, mediaQuery, windowTarget, observerFactory, intersect: visible => callback([{ isIntersecting: visible }]), disconnected: () => disconnected };
}
test('showcase requires local/parent visibility and pauses when the page is hidden', () => {
  const f = fixture(), states = [];
  const lifecycle = createShowcaseLifecycle({}, { ...f, onActiveChange: active => states.push(active) });
  f.intersect(true); assert.equal(lifecycle.getState().active, true);
  f.documentTarget.visibilityState = 'hidden'; f.documentTarget.emit('visibilitychange'); assert.equal(lifecycle.getState().active, false);
  f.documentTarget.visibilityState = 'visible'; f.documentTarget.emit('visibilitychange');
  f.windowTarget.emit('message', { source: f.parent, origin: 'https://preview.example', data: { type: 'relvyk:showcase-visibility', visible: false } });
  assert.equal(lifecycle.getState().active, false);
  f.windowTarget.emit('message', { source: f.parent, origin: 'https://preview.example', data: { type: 'relvyk:showcase-visibility', visible: true } });
  assert.equal(lifecycle.getState().active, true);
  f.intersect(false); assert.equal(lifecycle.getState().active, false);
  assert.deepEqual(states, [true, false, true, false, true, false]); lifecycle.destroy(); assert.equal(f.disconnected(), true);
});
test('showcase rejects foreign visibility messages and reacts to motion preference changes', () => {
  const f = fixture(), motions = [];
  const lifecycle = createShowcaseLifecycle({}, { ...f, onMotionChange: reduced => motions.push(reduced) }); f.intersect(true);
  for (const event of [{ source: f.parent, origin: 'https://foreign.example' }, { source: {}, origin: 'https://preview.example' }]) f.windowTarget.emit('message', { ...event, data: { type: 'relvyk:showcase-visibility', visible: false } });
  assert.equal(lifecycle.getState().active, true);
  f.mediaQuery.matches = true; f.mediaQuery.emit('change'); assert.deepEqual(motions, [true]);
  assert.equal(f.messages[0].origin, 'https://preview.example');
  assert.equal(f.messages[0].data.type, 'relvyk:showcase-ready');
  lifecycle.destroy(); f.mediaQuery.matches = false; f.mediaQuery.emit('change'); assert.deepEqual(motions, [true]);
});
test('parent bridge sends bounded same-origin state on intersection, load, hidden state and child readiness', () => {
  const f = fixture(), sent = [], child = { postMessage: (data, origin) => sent.push({ data, origin }) };
  const iframe = surface({ contentWindow: child });
  const bridge = createShowcaseVisibilityBridge(iframe, f); f.intersect(true); assert.equal(sent.at(-1).data.visible, true);
  f.documentTarget.visibilityState = 'hidden'; f.documentTarget.emit('visibilitychange'); assert.equal(sent.at(-1).data.visible, false);
  const count = sent.length; f.windowTarget.emit('message', { source: child, origin: 'https://foreign.example', data: { type: 'relvyk:showcase-ready' } }); assert.equal(sent.length, count);
  f.documentTarget.visibilityState = 'visible'; iframe.emit('load');
  f.windowTarget.emit('message', { source: child, origin: 'https://preview.example', data: { type: 'relvyk:showcase-ready' } });
  assert.equal(sent.at(-1).data.visible, true); assert.ok(sent.every(message => message.origin === 'https://preview.example' && message.data.type === 'relvyk:showcase-visibility'));
  bridge.destroy(); assert.equal(sent.at(-1).data.visible, false); assert.equal(f.disconnected(), true);
});
