/** The six existing SVG assemblies, mapped to the real task engine stages. */
export const MODEL_PARTS = Object.freeze([
  { organ: 'eyes', stage: 'SENSE', name: 'Eyes', duty: 'Identify the input and its data source.' },
  { organ: 'brain', stage: 'PLAN', name: 'Brain', duty: 'Choose the predefined read-only processing route.' },
  { organ: 'immune', stage: 'AUTHORIZE', name: 'Immune system', duty: 'Confirm the read-only boundary and access conditions.' },
  { organ: 'hands', stage: 'EXECUTE', name: 'Hands', duty: 'Read, parse, and compare the returned chain data.' },
  { organ: 'heart', stage: 'VERIFY', name: 'Verification gauge', duty: 'Check the result against explicit verification rules.' },
  { organ: 'memory', stage: 'REMEMBER', name: 'Memory', duty: 'Save the task and its evidence in this browser.' },
].map(part => Object.freeze(part)));
const byStage = new Map(MODEL_PARTS.map(part => [part.stage, part]));
const byOrgan = new Map(MODEL_PARTS.map(part => [part.organ, part]));

export function getVerificationPresentation(state = {}) {
  const checks = Array.isArray(state.checks) ? state.checks : [];
  const totals = { pass: 0, fail: 0, unknown: 0 };
  for (const check of checks) totals[['pass', 'fail', 'unknown'].includes(check.status) ? check.status : 'unknown']++;
  const step = (state.stepRecords || []).find(entry => entry.stage === 'VERIFY');
  const status = totals.fail ? 'fail' : totals.unknown ? 'unknown' : totals.pass ? 'pass' : step?.status === 'complete' ? 'unknown' : 'pending';
  return { status, ...totals };
}

export function getModelPresentation(state = {}, selectedStage = 'SENSE') {
  const selected = byStage.get(selectedStage) || MODEL_PARTS[0];
  const current = byStage.get(state.stage) || null;
  const replay = state.mode === 'replay' || state.status === 'replay';
  const processing = state.status === 'running' && !replay;
  const hasRecord = Boolean(state.runId);
  const limited = state.result?.summary?.taskStatus === 'incomplete' || state.record?.outcome === 'incomplete';
  const scope = state.record?.storageScope || state.storageStatus?.storageScope;
  const isExample = state.record?.recordKind === 'RecordedExample' || scope === 'packaged-example';
  const recordCaption = scope === 'memory' ? 'page session record' : scope === 'local' ? 'local record' : 'task record';
  const step = [...(Array.isArray(state.stepRecords) ? state.stepRecords : [])].reverse().find(entry => entry.stage === selected.stage);
  const caption = replay ? `${isExample ? 'Recorded Example / Replay' : 'Historical replay'}${limited ? ' · limited data' : ''} · ${scope === 'memory' ? 'page session record' : 'saved evidence'}`
    : state.status === 'idle' || !hasRecord ? 'Idle mechanical study'
      : processing ? `Read-only query · ${state.stage === 'INPUT' ? 'input' : state.stage}`
        : state.status === 'complete' ? `${limited ? 'Read completed · limited data' : 'Query complete'} · ${recordCaption}`
          : state.status === 'cancelled' ? 'Query cancelled'
            : state.status === 'error' ? 'Query needs attention' : 'Task record';
  return {
    selectedStage: selected.stage, selectedOrgan: selected.organ,
    activeStage: current?.stage || null, activeOrgan: current?.organ || null,
    processing, replay, caption, verification: getVerificationPresentation(state),
    duty: typeof step?.summary === 'string' ? step.summary : selected.duty,
    readout: `${selected.stage} · ${typeof step?.summary === 'string' ? step.summary : selected.duty}`,
  };
}

/**
 * Reuses existing SVG nodes. Task feedback is driven exclusively by setTaskState.
 * Idle needle movement and assembly springs never advance a task or its statistics.
 * @param {{onSelect?: (stage: string) => void, onHover?: (stage: string | null) => void, root?: ParentNode | null,
 *   windowTarget?: (Window & typeof globalThis) | null, documentTarget?: Document | null}} options
 */
export function createModelController({ onSelect, onHover, root = globalThis.document,
  windowTarget = globalThis.window, documentTarget = globalThis.document } = {}) {
  const figures = [...(/** @type {NodeListOf<HTMLElement>} */ (root?.querySelectorAll?.('[data-machine]')) || [])];
  const stages = figures.map(figure => /** @type {HTMLElement | null} */ (figure.querySelector('.machine-stage'))).filter(Boolean);
  const nodes = stages.flatMap(stage => [.../** @type {NodeListOf<HTMLElement | SVGGraphicsElement>} */ (stage.querySelectorAll('[data-organ]'))]);
  const motionPreference = windowTarget?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const reduced = () => Boolean(motionPreference?.matches);
  const subscriptions = [];
  const springs = new Map(nodes.map(node => [node, { x: 0, y: 0, vx: 0, vy: 0 }]));
  const anchors = new Map();
  const bounds = new Map();
  const views = new Map(stages.map(stage => {
    const svg = /** @type {SVGSVGElement | null} */ (stage.querySelector('svg'));
    const raw = (svg?.getAttribute('viewBox') || '0 0 760 520').split(/[\s,]+/).map(Number);
    const base = raw.length === 4 && raw.every(Number.isFinite) && raw[2] > 0 && raw[3] > 0 ? { x: raw[0], y: raw[1], width: raw[2], height: raw[3] } : { x: 0, y: 0, width: 760, height: 520 };
    return [stage, { svg, base, current: { ...base }, target: { ...base } }];
  }));
  const stateListeners = new Set();
  /** @type {Set<Element>} */
  const visibleFigures = new Set(figures);
  const requestFrame = windowTarget?.requestAnimationFrame?.bind(windowTarget);
  const cancelFrame = windowTarget?.cancelAnimationFrame?.bind(windowTarget);
  let frame = 0;
  let last = 0;
  let elapsed = 0;
  let selectedStage = 'SENSE';
  let hoveredStage = null;
  let manualSelection = false;
  let exploded = false;
  let explodeAmount = 0;
  let view = 'assembly';
  let focusedStage = null;
  let destroyed = false;
  let taskState = { status: 'idle', stage: 'INPUT', mode: 'query', runId: null, stepRecords: [] };

  function listen(target, event, handler) {
    target?.addEventListener?.(event, handler);
    subscriptions.push(() => target?.removeEventListener?.(event, handler));
  }
  function partFor(value) { return byStage.get(value) || byOrgan.get(value) || null; }
  function canAnimate() { return !destroyed && !reduced() && !documentTarget?.hidden && visibleFigures.size > 0; }
  function announce(message) { for (const figure of figures) { const live = figure.querySelector('[data-live]'); if (live) live.textContent = message; } }
  function updateMotionState() {
    for (const figure of figures) {
      const paused = destroyed || reduced() || Boolean(documentTarget?.hidden) || !visibleFigures.has(figure);
      figure.classList.toggle('is-paused', paused);
      figure.querySelector('.machine-stage')?.classList.toggle('is-paused', paused);
    }
  }
  function positionNeedle(idleAngle = 0) {
    const verification = getVerificationPresentation(taskState).status;
    const angle = (taskState.checks || []).length > 0 ? verification === 'pass' ? 13 : verification === 'fail' ? -13 : 0 : idleAngle;
    for (const stage of stages) stage.querySelector('[data-heart-needle]')?.setAttribute('transform', `rotate(${angle.toFixed(2)} 441.7 276)`);
  }

  function getViewState() {
    const presentation = getModelPresentation(taskState, selectedStage);
    return {
      view, explodeAmount, selectedStage, hoveredStage, focusedStage, manualSelection,
      reducedMotion: reduced(), presentation,
      task: { runId: taskState.runId || null, status: taskState.status || 'idle', stage: taskState.stage || 'INPUT', mode: taskState.mode || 'query' },
      parts: MODEL_PARTS.map((part, index) => ({ ...part, index: index + 1, selected: part.stage === selectedStage, hovered: part.stage === hoveredStage, status: (taskState.stepRecords || []).find(entry => entry.stage === part.stage)?.status || 'ready', processing: presentation.processing && presentation.activeStage === part.stage, verification: part.stage === 'VERIFY' ? presentation.verification.status : null })),
      viewBox: views.size ? { ...views.values().next().value.target } : { x: 0, y: 0, width: 760, height: 520 },
    };
  }
  function publishView() { for (const listener of stateListeners) { try { listener(getViewState()); } catch { /* A view subscriber cannot change task processing. */ } } }
  function hover(value) {
    if (destroyed) return;
    const next = partFor(value)?.stage || null;
    if (hoveredStage === next) return;
    hoveredStage = next; render();
    if (typeof onHover === 'function') onHover(next);
  }
  const clamp = (value, min, max) => min <= max ? Math.max(min, Math.min(max, value)) : 0;
  function targetPosition(node) {
    if (explodeAmount === 0) return { x: 0, y: 0 };
    const [mx = 0, my = 0] = (node.dataset.move || '0,0').split(',').map(value => Number(value) || 0);
    const box = bounds.get(node), parent = stages.find(stage => stage.contains?.(node)), base = views.get(parent)?.base;
    const x = mx * 1.35 * explodeAmount, y = my * 1.35 * explodeAmount;
    return box && base ? { x: clamp(x, base.x + 16 - box.x, base.x + base.width - 16 - box.x - box.width), y: clamp(y, base.y + 16 - box.y, base.y + base.height - 16 - box.y - box.height) } : { x, y };
  }
  function updateCameraTargets() {
    for (const [stage, camera] of views) {
      const part = byStage.get(focusedStage), node = part ? /** @type {HTMLElement | SVGGraphicsElement | null} */ (stage.querySelector(`[data-organ="${part.organ}"]`)) : null;
      const box = bounds.get(node), shift = node ? targetPosition(node) : null;
      if (!box || !shift) { camera.target = { ...camera.base }; continue; }
      const ratio = camera.base.width / camera.base.height;
      let width = Math.max(240, box.width * 1.7, box.height * 1.7 * ratio);
      width = Math.min(width, camera.base.width);
      const height = width / ratio;
      const centerX = box.x + box.width / 2 + shift.x, centerY = box.y + box.height / 2 + shift.y;
      camera.target = { x: clamp(centerX - width / 2, camera.base.x, camera.base.x + camera.base.width - width), y: clamp(centerY - height / 2, camera.base.y, camera.base.y + camera.base.height - height), width, height };
    }
  }
  function positionCamera(immediate = false) {
    for (const camera of views.values()) {
      for (const key of ['x', 'y', 'width', 'height']) camera.current[key] = immediate ? camera.target[key] : camera.current[key] + (camera.target[key] - camera.current[key]) * .14;
      camera.svg?.setAttribute('viewBox', ['x', 'y', 'width', 'height'].map(key => camera.current[key].toFixed(2)).join(' '));
    }
  }

  function positionOrb() {
    const active = byStage.get(taskState.stage);
    for (const stage of stages) {
      const orb = /** @type {SVGCircleElement | null} */ (stage.querySelector('[data-task-orb]'));
      if (!orb) continue;
      const positions = MODEL_PARTS.map(part => {
        const node = /** @type {HTMLElement | SVGGraphicsElement | null} */ (stage.querySelector(`[data-organ="${part.organ}"]`));
        const anchor = anchors.get(node);
        const spring = springs.get(node);
        return anchor ? { x: anchor.x + (spring?.x || 0), y: anchor.y + (spring?.y || 0) } : null;
      });
      const index = active ? MODEL_PARTS.findIndex(part => part.stage === active.stage) : 0;
      const position = positions[index];
      if (position) { orb.setAttribute('cx', position.x.toFixed(2)); orb.setAttribute('cy', position.y.toFixed(2)); }
      // A static position indicates the actual stage; it never travels according to a timer.
      orb.dataset.mode = taskState.mode === 'replay' ? 'replay' : taskState.status === 'running' ? 'query' : 'idle';
      const route = stage.querySelector('.task-track');
      if (route && positions.every(Boolean)) route.setAttribute('d', positions.map((point, i) => `${i ? 'L' : 'M'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' '));
    }
  }

  function render() {
    if (destroyed) return;
    const presentation = getModelPresentation(taskState, selectedStage);
    const selected = byStage.get(selectedStage);
    for (const stage of stages) {
      stage.dataset.focus = selected.organ;
      stage.dataset.taskState = taskState.status || 'idle';
      stage.dataset.taskStage = taskState.stage || 'INPUT';
      stage.dataset.mode = taskState.mode || 'query';
      stage.dataset.view = view;
      stage.dataset.explodeAmount = explodeAmount.toFixed(2);
      stage.dataset.verifyState = presentation.verification.status;
      stage.classList.toggle('is-trace-view', view === 'trace');
      stage.classList.toggle('is-focused-view', Boolean(focusedStage));
      if (hoveredStage) stage.dataset.hover = byStage.get(hoveredStage).organ;
      else delete stage.dataset.hover;
    }
    for (const node of nodes) {
      const part = byOrgan.get(node.dataset.organ);
      if (!part) continue;
      const active = part.stage === selectedStage;
      node.classList.toggle('is-active', active);
      node.classList.toggle('is-hovered', part.stage === hoveredStage);
      node.classList.toggle('is-processing', presentation.processing && part.stage === presentation.activeStage);
      node.classList.toggle('is-replaying', presentation.replay && part.stage === presentation.activeStage);
      node.classList.toggle('has-error', taskState.status === 'error' && part.stage === presentation.activeStage);
      node.classList.toggle('is-dimmed', Boolean(manualSelection) && !active && part.stage !== hoveredStage);
      node.classList.add(`phase-${part.stage.toLowerCase()}`);
      const step = (taskState.stepRecords || []).find(entry => entry.stage === part.stage);
      node.dataset.stepStatus = step?.status || 'ready';
      node.dataset.feedback = part.stage === 'VERIFY' ? presentation.verification.status : step?.status || 'ready';
      node.classList.toggle('has-completed-feedback', step?.status === 'complete');
      node.setAttribute('aria-pressed', String(active));
      node.setAttribute('aria-label', `${part.name}. ${part.stage}. ${getModelPresentation(taskState, part.stage).duty}`);
    }
    for (const figure of figures) {
      const readout = figure.querySelector('[data-readout]');
      const hint = figure.querySelector('[data-hint]');
      const assembly = figure.querySelector('[data-assembly-state]');
      if (readout) readout.textContent = presentation.readout;
      if (hint) hint.textContent = hoveredStage
        ? `${String(MODEL_PARTS.findIndex(part => part.stage === hoveredStage) + 1).padStart(2, '0')} / ${byStage.get(hoveredStage).name} · ${byStage.get(hoveredStage).duty}`
        : presentation.caption;
      if (assembly) assembly.textContent = view === 'trace' ? 'Trace' : explodeAmount === 0 ? 'Assembled' : explodeAmount === 1 ? 'Separated' : `Exploded ${Math.round(explodeAmount * 100)}%`;
    }
    for (const button of root?.querySelectorAll?.('[data-model-explode]') || []) {
      button.textContent = exploded ? 'Assemble' : 'Explode';
      button.setAttribute('aria-pressed', String(exploded));
    }
    for (const button of root?.querySelectorAll?.('[data-model-view]') || []) {
      const chosen = button.getAttribute('data-model-view')?.toLowerCase() === view;
      button.setAttribute('aria-pressed', String(chosen));
      button.classList.toggle('selected', chosen);
    }
    positionOrb();
    updateMotionState();
    publishView();
  }

  function select(stage, { manual = true, announceSelection = true } = {}) {
    const part = partFor(stage);
    if (!part || destroyed) return;
    selectedStage = part.stage;
    if (manual) manualSelection = true;
    const hadHover = hoveredStage !== null;
    hoveredStage = null;
    if (focusedStage) { focusedStage = selectedStage; updateCameraTargets(); }
    render();
    if (hadHover && typeof onHover === 'function') onHover(null);
    if (canAnimate()) run(); else positionCamera(true);
    if (announceSelection) announce(`${part.name}. ${part.stage}. ${getModelPresentation(taskState, part.stage).duty}`);
    if (typeof onSelect === 'function') onSelect(part.stage);
  }

  function settle() {
    for (const [node, spring] of springs) {
      const target = targetPosition(node);
      spring.x = target.x;
      spring.y = target.y;
      spring.vx = 0; spring.vy = 0;
      node.setAttribute('transform', `translate(${spring.x.toFixed(2)} ${spring.y.toFixed(2)})`);
    }
    positionOrb();
    positionNeedle();
    positionCamera(true);
  }

  function stopFrame() { if (frame) cancelFrame?.(frame); frame = 0; last = 0; }
  function tick(timestamp) {
    frame = 0;
    if (!canAnimate()) { settle(); return; }
    const dt = last ? Math.min((timestamp - last) / 1000, 1 / 30) : 1 / 60;
    last = timestamp;
    elapsed += dt;
    for (const [node, spring] of springs) {
      const target = targetPosition(node), tx = target.x, ty = target.y;
      for (let i = 0; i < 3; i++) {
        const step = dt / 3;
        spring.vx += ((tx - spring.x) * 68 - spring.vx * 15.5) * step;
        spring.vy += ((ty - spring.y) * 68 - spring.vy * 15.5) * step;
        spring.x += spring.vx * step;
        spring.y += spring.vy * step;
      }
      const executeMotion = taskState.status === 'running' && taskState.mode !== 'replay' && taskState.stage === 'EXECUTE' && node.dataset.organ === 'hands' ? Math.sin(elapsed * 5) * 1.2 : 0;
      node.setAttribute('transform', `translate(${spring.x.toFixed(2)} ${(spring.y + executeMotion).toFixed(2)})`);
    }
    positionNeedle(Math.sin(elapsed * 1.1) * 6);
    positionOrb();
    positionCamera();
    frame = requestFrame?.(tick) || 0;
  }
  function run() { if (!frame && canAnimate() && requestFrame) { last = 0; frame = requestFrame(tick); } }

  function explode(force) {
    if (destroyed) return;
    const next = typeof force === 'boolean' ? force : !exploded;
    setView(next ? 'exploded' : 'assembly');
  }
  function setExplodeAmount(amount) {
    if (destroyed || !Number.isFinite(Number(amount))) return;
    explodeAmount = clamp(Number(amount), 0, 1);
    exploded = explodeAmount > 0;
    if (view !== 'trace') view = exploded ? 'exploded' : 'assembly';
    for (const stage of stages) stage.classList.toggle('is-exploded', exploded);
    for (const figure of figures) figure.classList.toggle('is-separated', exploded);
    updateCameraTargets();
    render();
    if (canAnimate() && requestFrame) run(); else settle();
  }
  function setView(next) {
    const value = String(next).toLowerCase();
    if (!['assembly', 'exploded', 'trace'].includes(value) || destroyed) return;
    view = value; focusedStage = null;
    setExplodeAmount(value === 'assembly' ? 0 : value === 'exploded' ? 1 : .6);
    announce(`${value === 'trace' ? 'Task trace view' : value === 'exploded' ? 'Exploded view' : 'Assembly view'}. Task evidence is unchanged.`);
  }
  function focus(value = selectedStage) {
    const part = partFor(value);
    if (!part || destroyed) return;
    if (view === 'trace') view = explodeAmount > 0 ? 'exploded' : 'assembly';
    select(part.stage); focusedStage = part.stage;
    updateCameraTargets(); render();
    if (canAnimate() && requestFrame) run(); else positionCamera(true);
    announce(`Focused on ${part.name}, stage ${part.stage}. This is a two-dimensional SVG view.`);
  }

  function reset() {
    manualSelection = false;
    const hadHover = hoveredStage !== null;
    hoveredStage = null;
    if (hadHover && typeof onHover === 'function') onHover(null);
    focusedStage = null;
    explode(false);
    select(byStage.has(taskState.stage) && taskState.status !== 'idle' ? taskState.stage : 'SENSE', { manual: false });
    // There is no rotatable camera in the original SVG. Reset restores its actual view.
    positionNeedle();
    announce('Initial assembled view restored. Task evidence is unchanged.');
  }

  for (const node of nodes) {
    const part = byOrgan.get(node.dataset.organ);
    if (!part) continue;
    try { if ('getBBox' in node) { const box = node.getBBox(); if (box.width > 0 && box.height > 0) { bounds.set(node, { x: box.x, y: box.y, width: box.width, height: box.height }); anchors.set(node, { x: box.x + box.width / 2, y: box.y + box.height / 2 }); } } } catch { /* Existing SVG still works when layout measurement is unavailable. */ }
    node.setAttribute('tabindex', '0');
    node.setAttribute('role', 'button');
    listen(node, 'pointerenter', () => hover(part.stage));
    listen(node, 'pointerleave', () => hover(null));
    listen(node, 'focus', () => hover(part.stage));
    listen(node, 'blur', () => hover(null));
    listen(node, 'click', () => select(part.stage));
    listen(node, 'keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); event.stopPropagation(); select(part.stage);
      }
    });
  }
  for (const figure of figures) {
    figure.setAttribute('aria-label', 'Interactive Solana reflex engine. Arrow keys select an assembly. Space separates the engine. Escape restores the assembled view.');
    figure.querySelector('svg')?.setAttribute('role', 'group');
    figure.querySelector('svg')?.setAttribute('aria-label', 'Six mechanical assemblies for SENSE, PLAN, AUTHORIZE, EXECUTE, VERIFY and REMEMBER.');
    listen(figure, 'keydown', event => {
      const index = MODEL_PARTS.findIndex(part => part.stage === selectedStage);
      if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        const delta = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1;
        const next = MODEL_PARTS[(index + delta + MODEL_PARTS.length) % MODEL_PARTS.length];
        select(next.stage);
        if (event.target !== figure) (/** @type {HTMLElement | SVGElement | null} */ (figure.querySelector(`[data-organ="${next.organ}"]`)))?.focus?.();
      } else if (event.key === ' ' && event.target === figure) { event.preventDefault(); explode(); }
      else if (event.key === 'Escape') { event.preventDefault(); reset(); }
    });
  }
  for (const button of root?.querySelectorAll?.('[data-model-explode]') || []) listen(button, 'click', () => explode());
  for (const button of root?.querySelectorAll?.('[data-model-reset]') || []) listen(button, 'click', reset);
  for (const button of root?.querySelectorAll?.('[data-model-focus]') || []) listen(button, 'click', () => focus());
  for (const button of root?.querySelectorAll?.('[data-model-view]') || []) listen(button, 'click', () => setView(button.getAttribute('data-model-view')));
  for (const slider of root?.querySelectorAll?.('[data-model-explode-amount]') || []) listen(slider, 'input', () => setExplodeAmount(Number((/** @type {HTMLInputElement} */ (slider)).value)));

  const IntersectionObserverClass = windowTarget?.IntersectionObserver || globalThis.IntersectionObserver;
  const observer = IntersectionObserverClass && figures.length ? new IntersectionObserverClass(entries => {
    for (const entry of entries) { if (entry.isIntersecting) visibleFigures.add(entry.target); else visibleFigures.delete(entry.target); }
    updateMotionState();
    if (canAnimate()) run(); else { stopFrame(); settle(); }
  }, { rootMargin: '50px' }) : null;
  for (const figure of figures) observer?.observe(figure);
  listen(documentTarget, 'visibilitychange', () => { updateMotionState(); if (canAnimate()) run(); else { stopFrame(); settle(); } });
  listen(motionPreference, 'change', () => {
    updateMotionState();
    if (reduced()) { stopFrame(); settle(); }
    else run();
  });
  render();
  run();

  return Object.freeze({
    select, hover, explode, reset, setView, setExplodeAmount, focus, getViewState,
    subscribe(listener) { if (typeof listener !== 'function') return () => {}; stateListeners.add(listener); listener(getViewState()); return () => stateListeners.delete(listener); },
    getStageDetail(value = selectedStage) {
      const part = partFor(value); if (!part) return null;
      const record = (taskState.stepRecords || []).find(entry => entry.stage === part.stage);
      const input = { type: taskState.task?.type || taskState.record?.taskType || null, input: taskState.task?.input || taskState.record?.input || null, network: taskState.task?.network || taskState.record?.network || null };
      const outputs = {
        SENSE: { ...input, dataSource: taskState.dataSource || null },
        PLAN: { templateId: taskState.task?.templateId || taskState.record?.templateId || null, templateVersion: taskState.task?.templateVersion || taskState.record?.templateVersion || null, ruleVersion: taskState.record?.ruleVersion || null, route: MODEL_PARTS.map(part => part.stage) },
        AUTHORIZE: { scope: 'public-read', assetApprovalRequested: false, chainTransactionBroadcast: false },
        EXECUTE: taskState.result ? { kind: taskState.result.kind, summary: taskState.result.summary, observedAt: taskState.result.observedAt, dataSource: taskState.result.dataSource } : null,
        VERIFY: getVerificationPresentation(taskState),
        REMEMBER: taskState.record ? { runId: taskState.runId, storageScope: taskState.record.storageScope, outcome: taskState.record.outcome, completedAt: taskState.record.completedAt } : null,
      };
      return { stage: part.stage, part: { ...part }, input, step: record ? { ...record } : null, output: taskState.runId ? outputs[part.stage] : null, checks: part.stage === 'VERIFY' ? [...(taskState.checks || [])] : [], evidenceRefs: part.stage === 'REMEMBER' && taskState.record ? [{ kind: 'local-record', runId: taskState.runId }] : [...(record?.evidenceRefs || [])], mode: taskState.mode || 'query' };
    },
    setFollowTask(enabled = true) { manualSelection = !enabled; if (enabled && byStage.has(taskState.stage)) { selectedStage = taskState.stage; if (focusedStage) focusedStage = selectedStage; updateCameraTargets(); } render(); if (canAnimate()) run(); else positionCamera(true); },
    setTaskState(state) {
      if (destroyed || !state || typeof state !== 'object') return;
      taskState = state;
      if (!manualSelection) { selectedStage = byStage.has(state.stage) ? state.stage : 'SENSE'; if (focusedStage) focusedStage = selectedStage; updateCameraTargets(); }
      render();
      if (!canAnimate()) positionNeedle();
      run();
    },
    destroy() { destroyed = true; updateMotionState(); stopFrame(); observer?.disconnect(); subscriptions.forEach(unsubscribe => unsubscribe()); stateListeners.clear(); },
  });
}
