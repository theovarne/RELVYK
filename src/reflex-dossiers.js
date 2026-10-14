import { node, action, utc, shortAddress } from './ui-helpers.js';

/** @typedef {Omit<typeof import('./reflex-library.js').REFLEX_TEMPLATES[number], 'executionCount'> & {executionCount: number}} DossierTemplate */
/** @typedef {{runId: string, input: string, outcome: string, completedAt?: string, network?: string}} DossierRecord */
const SVG = 'http://www.w3.org/2000/svg';
function diagram(type) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 180 88'); svg.setAttribute('role', 'img'); svg.setAttribute('class', 'dossier-diagram'); svg.setAttribute('width', '180'); svg.setAttribute('height', '88');
  const specs = {
    transaction: { label: 'Account to instructions to observations', boxes: [[8, 30, 'ACCOUNT'], [66, 30, 'INSTR.'], [124, 30, 'RESULT']], paths: ['M54 44H66', 'M112 44H124'] },
    token: { label: 'Mint properties linked to authority checks', boxes: [[8, 30, 'MINT'], [104, 6, 'MINT A.'], [104, 56, 'FREEZE']], paths: ['M54 44H80V20H104', 'M80 44V70H104'] },
    snapshot: { label: 'Two recorded captures to balance differences', boxes: [[8, 6, 'READ A'], [8, 56, 'READ B'], [124, 30, 'DELTA']], paths: ['M54 20H80V44H124', 'M54 70H80V44'] },
  };
  const spec = Object.hasOwn(specs, type) ? specs[type] : specs.transaction;
  svg.setAttribute('aria-label', spec.label);
  for (const data of spec.paths) { const path = document.createElementNS(SVG, 'path'); path.setAttribute('d', data); path.setAttribute('class', 'dossier-wire'); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); svg.append(path); }
  for (const [x, y, label] of spec.boxes) {
    const box = document.createElementNS(SVG, 'rect'); box.setAttribute('x', String(x)); box.setAttribute('y', String(y)); box.setAttribute('width', '46'); box.setAttribute('height', '28'); box.setAttribute('rx', '2'); box.setAttribute('class', 'dossier-box'); box.setAttribute('fill', 'none'); box.setAttribute('stroke', 'currentColor');
    const text = document.createElementNS(SVG, 'text'); text.setAttribute('x', String(Number(x) + 23)); text.setAttribute('y', String(Number(y) + 17)); text.setAttribute('text-anchor', 'middle'); text.setAttribute('font-size', '8'); text.textContent = String(label); svg.append(box, text);
  }
  return svg;
}
function inputDetails(template, panel) {
  const facts = node('dl', 'dossier-facts');
  for (const [key, value] of [['Input', template.inputSchema?.properties?.input?.description || 'Use the input required by this task.'], ['Version', template.version], ['Check version', template.ruleVersion || template.sourceVersion || template.version], ['Created UTC', utc(template.createdAt)], ['Last verified UTC', template.lastVerifiedAt ? utc(template.lastVerifiedAt) : 'No completed run']]) facts.append(node('dt', '', key), node('dd', '', value));
  if (template.parameters) facts.append(node('dt', '', 'Saved input'), node('dd', 'mono', template.parameters.input), node('dt', '', 'Saved network'), node('dd', 'mono', template.parameters.network));
  const route = node('ol', 'dossier-route'); for (const step of template.steps || []) route.append(node('li', '', step.stage));
  panel.append(facts, node('h4', '', 'Processing route'), route);
}

/**
 * Render supplied real library state; this module performs no queries or storage.
 * @param {HTMLElement} container
 * @param {DossierTemplate[]} templates
 * @param {{selectedId?: string, onRun?: (template: DossierTemplate) => unknown, onCopy?: (template: DossierTemplate) => unknown, getRecords?: (template: DossierTemplate) => Promise<DossierRecord[]>, onRecord?: (record: DossierRecord) => unknown, onSelect?: (template: DossierTemplate) => unknown, onError?: (error: Error) => void}} [options]
 */
export function renderDossiers(container, templates, options = {}) {
  container.replaceChildren(); container.classList.add('dossier-list');
  let selectedId = options.selectedId || null, destroyed = false;
  const entries = new Map();
  function setSelected(id) {
    selectedId = id;
    for (const [key, entry] of entries) { entry.row.classList.toggle('is-selected', key === id); entry.row.setAttribute('aria-current', key === id ? 'true' : 'false'); }
  }
  function open(id, tab = 'inputs') {
    const entry = entries.get(id); if (!entry || destroyed) return;
    setSelected(id); entry.details.open = true; entry.panel.dataset.tab = tab; entry.panel.replaceChildren();
    for (const [name, button] of entry.buttons) button.setAttribute('aria-pressed', String(name === tab));
    const revision = ++entry.revision;
    if (tab === 'checks') {
      entry.panel.append(node('h4', '', 'Defined checks'));
      const list = node('ol', 'dossier-checks');
      for (const check of entry.template.checks || []) { const item = node('li'); item.append(node('strong', '', check.label), node('code', 'mono', check.id)); if ('scope' in check && check.scope) item.append(node('p', '', check.scope)); list.append(item); }
      entry.panel.append(list);
    } else if (tab === 'records') {
      entry.panel.append(node('h4', '', 'Records for this template version'));
      const records = node('div', 'dossier-records'); entry.panel.append(records);
      if (!options.getRecords) records.append(node('p', 'small-note', 'Open Evidence to inspect saved runs.'));
      else {
        records.append(node('p', 'small-note', 'Reading saved records…'));
        options.getRecords(entry.template).then(items => {
          if (destroyed || entry.revision !== revision) return;
          records.replaceChildren();
          if (!items.length) records.append(node('p', 'small-note', 'No saved reads for this template version.'));
          for (const record of items) { const line = node('div', 'dossier-record'); line.append(action(`${utc(record.completedAt)} · ${record.outcome}`, () => options.onRecord?.(record)), node('code', 'mono', shortAddress(record.input))); records.append(line); }
        }).catch(error => { if (!destroyed && entry.revision === revision) records.replaceChildren(node('p', 'form-error', 'Saved records could not be read. Try again.')); options.onError?.(error); });
      }
    } else inputDetails(entry.template, entry.panel);
  }
  if (!templates.length) container.append(node('p', 'empty-state', 'No matching workflows. Clear the search or choose another type.'));
  for (const [index, template] of templates.entries()) {
    const row = node('article', 'reflex-dossier'); row.dataset.templateId = template.id;
    const drawing = node('div', 'dossier-drawing'); drawing.append(node('span', 'dossier-number mono', String(index + 1).padStart(2, '0')), diagram(template.type));
    const body = node('div', 'dossier-body'); body.append(node('p', 'dossier-type', template.type.toUpperCase()), node('h3', '', template.title), node('p', 'dossier-description', template.description));
    const meta = node('div', 'dossier-meta'); meta.append(node('span', 'mono', `V${template.version}`), node('span', '', template.parameters ? 'Saved parameters' : 'Defined route'), node('span', '', Number.isInteger(template.executionCount) ? `${template.executionCount} recorded ${template.executionCount === 1 ? 'run' : 'runs'}` : 'Run count not available')); body.append(meta);
    const details = node('details', 'dossier-details'), summary = node('summary', '', 'Input & route'), panel = node('div', 'dossier-panel'); details.append(summary, panel); body.append(details);
    const controls = node('div', 'dossier-actions'), buttons = new Map();
    controls.append(action('Run →', () => { setSelected(template.id); return options.onRun?.(template); }, 'button primary'));
    for (const [tab, label] of [['checks', 'View Checks'], ['records', 'View Records']]) { const button = action(label, () => open(template.id, tab), 'dossier-action'); button.setAttribute('aria-pressed', 'false'); buttons.set(tab, button); controls.append(button); }
    if (options.onCopy) controls.append(action('Save Copy', () => options.onCopy(template), 'dossier-action'));
    row.append(drawing, body, controls); entries.set(template.id, { row, details, panel, buttons, template, revision: 0 }); inputDetails(template, panel);
    summary.addEventListener('click', event => { event.preventDefault(); setSelected(template.id); if (details.open) details.open = false; else open(template.id, 'inputs'); });
    row.addEventListener('focusin', () => { setSelected(template.id); options.onSelect?.(template); }); container.append(row);
  }
  setSelected(selectedId);
  return { setSelected, open, destroy() { destroyed = true; for (const entry of entries.values()) entry.revision++; } };
}
