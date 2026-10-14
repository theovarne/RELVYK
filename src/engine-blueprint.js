import { MODEL_PARTS } from './model-controller.js';

const POSITIONS = [[110, 94], [340, 94], [570, 94], [570, 258], [340, 258], [110, 258]];
let instance = 0;

/** The blueprint is a presentation of the model controller, not a second task engine. */
export function getBlueprintPresentation(viewState = {}) {
  const parts = viewState.parts || MODEL_PARTS.map((part, index) => ({ ...part, index: index + 1, status: 'ready' }));
  return {
    view: viewState.view || 'assembly', selectedStage: viewState.selectedStage || 'SENSE', hoveredStage: viewState.hoveredStage || null,
    mode: viewState.task?.mode === 'replay' ? 'replay' : viewState.presentation?.processing ? 'query' : 'structure',
    caption: viewState.presentation?.caption || 'Idle mechanical study',
    nodes: parts.map((part, index) => ({ ...part, x: POSITIONS[index][0], y: POSITIONS[index][1], selected: part.stage === viewState.selectedStage, hovered: part.stage === viewState.hoveredStage })),
    links: parts.slice(1).map((part, index) => ({ from: parts[index].stage, to: part.stage, traversed: ['complete', 'failed'].includes(parts[index].status), current: Boolean(viewState.presentation?.processing && viewState.task?.stage === part.stage), selected: viewState.task?.mode === 'replay' && viewState.selectedStage === part.stage })),
  };
}

/**
 * @param {{container: HTMLElement, model: ReturnType<typeof import('./model-controller.js').createModelController>,
 * onSelect?: (stage: string) => void, onHover?: (stage: string | null) => void}} options
 */
export function createEngineBlueprint({ container, model, onSelect, onHover }) {
  if (!container || !model) throw new TypeError('A blueprint needs a container and the existing model controller.');
  const doc = container.ownerDocument;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const disposers = [];
  function svgNode(tag, attrs = {}, text) {
    const element = doc.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    if (text !== undefined) element.textContent = String(text);
    return element;
  }
  function listen(target, name, callback) { target.addEventListener(name, callback); disposers.push(() => target.removeEventListener(name, callback)); }
  const svg = svgNode('svg', { class: 'engine-blueprint-svg', viewBox: '0 0 680 355', role: 'group', 'aria-label': 'Interactive six-stage processing blueprint. Select a node to inspect its assembly and saved evidence.' });
  const arrowId = `blueprint-arrow-${++instance}`;
  const defs = svgNode('defs');
  const marker = svgNode('marker', { id: arrowId, viewBox: '0 0 6 6', refX: '5', refY: '3', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' });
  marker.append(svgNode('path', { d: 'M0 0 L6 3 L0 6 Z', fill: 'currentColor' })); defs.append(marker); svg.append(defs);
  const lines = [];
  for (let i = 1; i < POSITIONS.length; i++) {
    const a = POSITIONS[i - 1], b = POSITIONS[i];
    const horizontal = a[1] === b[1], direction = Math.sign(horizontal ? b[0] - a[0] : b[1] - a[1]);
    const start = horizontal ? [a[0] + 89 * direction, a[1]] : [a[0], a[1] + 40 * direction];
    const end = horizontal ? [b[0] - 94 * direction, b[1]] : [b[0], b[1] - 47 * direction];
    const path = svgNode('path', { class: 'blueprint-link', d: `M${start.join(' ')} L${end.join(' ')}`, fill: 'none', stroke: 'currentColor', 'stroke-width': '1', 'marker-end': `url(#${arrowId})`, 'aria-hidden': 'true' });
    lines.push(path); svg.append(path);
  }
  const groups = [];
  MODEL_PARTS.forEach((part, index) => {
    const [x, y] = POSITIONS[index];
    const group = svgNode('g', { class: 'blueprint-node', transform: `translate(${x} ${y})`, tabindex: '0', role: 'button', 'data-stage': part.stage, 'aria-label': `${index + 1}. ${part.stage}. ${part.name}. ${part.duty}` });
    group.append(svgNode('rect', { class: 'blueprint-node-plate', x: '-87', y: '-39', width: '174', height: '78', rx: '2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1' }));
    group.append(svgNode('path', { class: 'blueprint-crosshair', d: 'M-94 -39h12 M-87 -46v13 M94 39h-12 M87 46v-13', fill: 'none', stroke: 'currentColor', 'stroke-width': '.7', 'aria-hidden': 'true' }));
    group.append(svgNode('text', { class: 'blueprint-number', x: '-73', y: '-19', 'font-size': '10', fill: 'currentColor' }, String(index + 1).padStart(2, '0')));
    group.append(svgNode('text', { class: 'blueprint-label', x: '-73', y: '1', 'font-size': '15', fill: 'currentColor' }, part.stage));
    group.append(svgNode('text', { class: 'blueprint-part', x: '-73', y: '23', 'font-size': '10', fill: 'currentColor' }, part.name));
    group.append(svgNode('title', {}, part.duty));
    const choose = () => { model.select(part.stage); onSelect?.(part.stage); };
    const hover = value => { model.hover(value); onHover?.(value); };
    listen(group, 'pointerenter', () => hover(part.stage)); listen(group, 'pointerleave', () => hover(null));
    listen(group, 'focus', () => hover(part.stage)); listen(group, 'blur', () => hover(null));
    listen(group, 'click', choose);
    listen(group, 'keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); }
      else if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? MODEL_PARTS.length - 1 : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + MODEL_PARTS.length) % MODEL_PARTS.length;
        model.select(MODEL_PARTS[next].stage); groups[next]?.focus();
      } else if (event.key === 'Escape') { event.preventDefault(); model.hover(null); }
    });
    groups.push(group); svg.append(group);
  });
  const caption = doc.createElement('div'); caption.className = 'blueprint-caption';
  const stateLabel = doc.createElement('span'), modeLabel = doc.createElement('span'); caption.append(stateLabel, modeLabel);
  container.replaceChildren(svg, caption);
  let state = getBlueprintPresentation(model.getViewState());
  const unsubscribe = model.subscribe(viewState => {
    state = getBlueprintPresentation(viewState);
    container.dataset.mode = state.mode;
    groups.forEach((group, index) => {
      const node = state.nodes[index];
      group.classList.toggle('is-selected', node.selected); group.classList.toggle('is-hovered', node.hovered);
      group.classList.toggle('is-processing', Boolean(node.processing));
      group.dataset.status = node.status; group.dataset.verifyState = node.verification || 'pending';
      group.setAttribute('aria-pressed', String(node.selected));
    });
    lines.forEach((line, index) => {
      const link = state.links[index];
      line.classList.toggle('is-current', link.current); line.classList.toggle('is-traversed', link.traversed); line.classList.toggle('is-replaying', link.selected);
    });
    stateLabel.textContent = `Selected / ${state.selectedStage}`;
    modeLabel.textContent = state.mode === 'replay' ? 'RECORDED RUN / REPLAY' : state.mode === 'query' ? 'READ-ONLY QUERY' : 'STRUCTURE / NO ACTIVE QUERY';
  });
  return {
    getState: () => state,
    getStageDetail: stage => model.getStageDetail(stage),
    destroy() { unsubscribe(); disposers.forEach(dispose => dispose()); container.replaceChildren(); },
  };
}
