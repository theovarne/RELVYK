import { node, action, utc, shortAddress, safeJSON } from './ui-helpers.js';

/** @typedef {{id: string, label?: string, title?: string, status: string, finding?: string, evidence?: unknown, limitation?: string}} EvidenceCheck */
/** @typedef {{runId: string, recordKind?: string, taskType: string, input: string, network: string, outcome: string, startedAt?: string, completedAt?: string, observedAt?: string, dataSource?: string | Record<string, unknown>, storageScope?: string, templateVersion?: string, trigger?: {kind?: string}, observationKind?: string, result?: {raw?: unknown, summary?: Record<string, unknown>, evidenceRefs?: Array<{id?: string, method?: string}>}, checks?: EvidenceCheck[], stepRecords?: Array<import('./task-engine.js').StepRecord>}} EvidenceRecord */
const labels = { transaction: 'Transaction inspection', token: 'Mint anatomy', snapshot: 'Account snapshot' };
let panelId = 0;
const text = value => typeof value === 'string' ? value : safeJSON(value) ?? 'Not returned';
function pill(status, label) { return node('span', `pill ${['pass', 'fail', 'unknown'].includes(status) ? status : 'neutral'}`, label); }
function facts(container, entries) { const list = node('dl', 'facts-grid evidence-facts'); for (const [label, value] of entries) { const fact = node('div'); fact.append(node('dt', '', label), node('dd', '', value)); list.append(fact); } container.append(list); }
function pathTokens(value) {
  if (typeof value !== 'string' || !value || value.length > 300) return null;
  if (value.startsWith('/')) return value.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
  const source = value.replace(/^\$\.?/, '');
  if (!/^[A-Za-z_$][\w$]*(?:(?:\.[A-Za-z_$][\w$]*)|(?:\[\d+\]))*$/.test(source)) return null;
  return source.match(/[A-Za-z_$][\w$]*|\d+/g);
}
function readPath(value, tokens) {
  let current = value;
  for (const token of tokens) { if (!current || typeof current !== 'object' || !Object.hasOwn(current, token)) return { found: false }; current = current[token]; }
  return { found: true, value: current };
}
function storedPath(tokens) { return tokens.map((token, index) => /^\d+$/.test(token) ? `[${token}]` : `${index ? '.' : ''}${token}`).join(''); }

/** Resolve only explicit paths against actual saved evidence, never prose or guessed field names. */
export function resolveEvidencePaths(record, check) {
  const source = check.evidence;
  const items = Array.isArray(source) ? source : [source];
  const expressions = items.flatMap(item => typeof item === 'string' ? item.split(';').map(value => value.trim()) : item && typeof item === 'object' && typeof item.path === 'string' ? [item.path] : []);
  const fields = [], unresolved = [];
  for (const expression of expressions) {
    const tokens = pathTokens(expression); if (!tokens?.length || tokens.length > 24) { unresolved.push(expression); continue; }
    const exact = readPath(record, tokens);
    if (exact.found) { fields.push({ sourcePath: expression, path: storedPath(tokens), value: exact.value }); continue; }
    const raw = record.result?.raw;
    const refs = record.result?.evidenceRefs || [];
    const mappings = [
      { method: 'getTransaction', id: 'transaction', key: 'transaction' },
      { method: 'getSignatureStatuses', id: 'finality', key: 'signatureStatus' },
      { method: 'getAccountInfo', id: 'mint-account', key: 'account' },
    ];
    let methodMatch = false;
    for (const map of mappings) {
      if (tokens[0] !== map.method || tokens[1] !== 'result' || !refs.some(ref => ref.id === map.id && ref.method === map.method)) continue;
      const found = readPath(raw, [map.key, ...tokens.slice(2)]);
      if (found.found) { fields.push({ sourcePath: expression, path: `result.raw.${map.key}${tokens.length > 2 ? '.' + storedPath(tokens.slice(2)) : ''}`, value: found.value }); methodMatch = true; }
    }
    if (methodMatch) continue;
    // A plain path such as meta.err can match one actual source node. Multiple
    // matches are ambiguous and remain unknown; no fuzzy property search occurs.
    const candidates = []; let visited = 0;
    function walk(value, prefix, depth) {
      if (!value || typeof value !== 'object' || depth > 24 || ++visited > 12000) return;
      const found = readPath(value, tokens); if (found.found) candidates.push({ sourcePath: expression, path: storedPath([...prefix, ...tokens]), value: found.value });
      if (candidates.length > 1) return;
      for (const [key, child] of Object.entries(value)) { walk(child, [...prefix, key], depth + 1); if (visited > 12000 || candidates.length > 1) break; }
    }
    walk(raw, ['result', 'raw'], 0);
    if (candidates.length === 1 && visited <= 12000) fields.push(candidates[0]); else unresolved.push(expression);
  }
  return { fields, unresolved, original: source, status: fields.length && !unresolved.length ? 'resolved' : 'unknown' };
}

/** @param {HTMLElement} container @param {EvidenceRecord[]} records @param {{view?: 'list'|'timeline',selectedId?: string,onOpen?: (record: EvidenceRecord) => unknown}} [options] */
export function renderEvidenceList(container, records, { view = 'list', selectedId, onOpen } = {}) {
  container.replaceChildren(); container.dataset.view = view; container.classList.add('evidence-collection');
  if (!records.length) { container.append(node('p', 'empty-state', 'No observations match the current filters.')); return; }
  let group = container, currentDay = '';
  for (const record of records) {
    if (view === 'timeline') { const day = utc(record.completedAt).slice(0, 10); if (day !== currentDay) { currentDay = day; group = node('section', 'evidence-day'); group.append(node('h3', 'mono', `${day} / UTC`)); container.append(group); } }
    const row = node('article', `evidence-row${record.runId === selectedId ? ' is-selected' : ''}`); row.dataset.runId = record.runId;
    const identity = node('div', 'evidence-row-identity'); identity.append(node('span', 'type-label', labels[record.taskType] || record.taskType), node('strong', 'mono', shortAddress(record.input)), node('small', '', `${record.network} · ${record.runId}`));
    row.append(identity, node('time', '', utc(record.completedAt)), pill(record.outcome === 'completed' ? 'pass' : 'unknown', record.outcome === 'completed' ? 'Parsed' : record.outcome), action('Open evidence ↗', () => onOpen?.(record), 'evidence-open')); group.append(row);
  }
}

/**
 * @param {HTMLElement} container
 * @param {EvidenceRecord} record
 * @param {{initialTab?: string, onReplay?: (record: EvidenceRecord) => unknown, onStep?: (record: EvidenceRecord, step: import('./task-engine.js').StepRecord, index: number) => unknown, onExport?: (record: EvidenceRecord) => unknown, onDelete?: (record: EvidenceRecord) => unknown, copyText?: (text: string) => boolean | void | Promise<boolean | void>}} [options]
 */
export function renderEvidenceDetail(container, record, options = {}) {
  container.replaceChildren(); container.classList.add('evidence-drawer-content');
  const id = `evidence-panel-${++panelId}`, header = node('header', 'evidence-drawer-header'), actions = node('div', 'record-actions');
  const title = node('div'); title.append(node('p', 'eyebrow', record.recordKind === 'RecordedExample' ? 'RECORDED EXAMPLE / PACKAGED EVIDENCE' : 'RECORDED RUN / LOCAL EVIDENCE'), node('h2', '', labels[record.taskType] || record.taskType), node('code', 'mono', record.runId));
  if (options.onReplay) actions.append(action(record.recordKind === 'RecordedExample' ? 'Replay Example' : 'Replay Recorded Run', () => options.onReplay(record), 'button primary'));
  if (options.onExport) actions.append(action('Export JSON', () => options.onExport(record)));
  if (options.onDelete) actions.append(action('Delete local record', () => options.onDelete(record)));
  header.append(title, actions); container.append(header);
  const tabs = node('div', 'evidence-detail-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Evidence detail layers');
  const content = node('div', 'evidence-tab-content'); content.id = id; content.setAttribute('role', 'tabpanel'); content.tabIndex = 0;
  container.append(tabs, content);
  let currentTab = options.initialTab || 'summary', selectedCheck = null, selectedStep = 0, destroyed = false;
  const buttons = new Map(), layers = [['summary', 'Summary'], ['steps', 'Steps'], ['checks', 'Checks'], ['raw', 'Raw Data']];
  function focusedEvidence(parent, check) {
    const selection = resolveEvidencePaths(record, check), box = node('aside', 'evidence-field-focus');
    box.setAttribute('aria-live', 'polite'); box.append(node('p', 'eyebrow', 'EVIDENCE FOCUS'), node('h4', '', check.label || check.title || check.id));
    for (const field of selection.fields) { const label = node('mark', 'evidence-field-path mono', field.path), pre = node('pre', 'raw-block evidence-field-value', safeJSON(field.value)); pre.tabIndex = 0; box.append(label, pre); }
    if (selection.status === 'unknown') box.append(pill('unknown', 'Unresolved source path'), node('p', 'small-note', 'The record does not establish a unique field path for all supplied evidence. The original evidence is retained below.'));
    box.append(node('pre', 'evidence-original-reference', text(check.evidence)));
    if (check.limitation) box.append(node('p', 'small-note', check.limitation)); parent.append(box);
  }
  function setTab(tab) {
    if (destroyed || !buttons.has(tab)) return;
    currentTab = tab;
    for (const [key, button] of buttons) { button.setAttribute('aria-selected', String(key === tab)); button.tabIndex = key === tab ? 0 : -1; }
    content.setAttribute('aria-labelledby', `${id}-${tab}`); content.dataset.tab = tab; content.replaceChildren();
    if (tab === 'summary') {
      const source = typeof record.dataSource === 'string' ? record.dataSource : record.dataSource?.label || record.dataSource?.detail || 'No usable source response';
      facts(content, [['Network', record.network], ['Input', record.input], ['Outcome', record.outcome], ['Source', source], ['Observed UTC', utc(record.observedAt)], ['Started UTC', utc(record.startedAt)], ['Completed UTC', utc(record.completedAt)], ['Trigger', record.trigger?.kind || 'Not recorded'], ['Rule version', record.templateVersion], ['Storage', record.recordKind === 'RecordedExample' ? 'Packaged historical example' : record.storageScope === 'local' ? 'Saved in this browser' : 'Saved in this page session']]);
      const summary = record.result?.summary;
      if (summary && record.taskType === 'transaction') facts(content, [['Chain execution', summary.chainStatus], ['Finality', summary.finality], ['Slot', summary.slot], ['Fee · SOL', summary.feeSOL], ['Version', summary.version]]);
      else if (summary && record.taskType === 'token') facts(content, [['Token Program', summary.program], ['Supply', summary.supply], ['Decimals', summary.decimals]]);
      else if (summary && record.taskType === 'snapshot') facts(content, [['Owner', summary.owner], ['SOL', summary.solBalance], ['Scope', summary.complete === true ? 'Recorded public balance scope' : 'Partial capture']]);
      content.append(node('p', 'note-box', 'This is saved evidence. Reading it or replaying steps does not query the chain or add a real execution.'));
    } else if (tab === 'steps') {
      const route = node('ol', 'evidence-step-timeline');
      for (const [index, step] of (record.stepRecords || []).entries()) {
        const item = node('li', index === selectedStep ? 'is-selected' : '');
        const button = action(`${String(index + 1).padStart(2, '0')} / ${step.stage}`, () => { selectedStep = index; setTab('steps'); return options.onStep?.(record, step, index); }, 'evidence-step-button');
        button.setAttribute('aria-current', index === selectedStep ? 'step' : 'false'); item.append(button, node('span', 'mono', step.status)); route.append(item);
      }
      content.append(route); const step = record.stepRecords?.[selectedStep];
      if (step) { content.append(node('h3', '', step.stage), node('p', 'evidence-step-summary', step.summary)); facts(content, [['Started UTC', utc(step.startedAt)], ['Completed UTC', utc(step.completedAt)]]); if (step.evidenceRefs?.length) content.append(node('pre', 'raw-block', safeJSON(step.evidenceRefs))); }
      else content.append(node('p', 'empty-state', 'No stage records were saved.'));
    } else if (tab === 'checks') {
      const list = node('div', 'evidence-check-list');
      for (const check of record.checks || []) { const item = node('article', `evidence-check${selectedCheck?.id === check.id ? ' is-selected' : ''}`); const button = action(check.label || check.title || check.id, () => selectCheck(check.id), 'check-evidence-button'); button.dataset.checkId = check.id; button.setAttribute('aria-pressed', String(selectedCheck?.id === check.id)); item.append(pill(check.status, check.status === 'pass' ? 'Checked' : check.status === 'fail' ? 'Finding' : 'Unknown'), button, node('p', '', check.finding)); list.append(item); }
      content.append(list); if (selectedCheck) focusedEvidence(content, selectedCheck); else content.append(node('p', 'small-note', 'Choose a check to inspect the exact stored evidence it references.'));
    } else {
      if (selectedCheck) focusedEvidence(content, selectedCheck);
      const details = node('details', 'evidence-raw-details'), heading = node('summary', '', 'Complete saved record & original responses'); details.append(heading);
      if (options.copyText) { const copy = action('Copy JSON', async () => { const copied = await options.copyText(safeJSON(record)); copy.textContent = copied === false ? 'Retry copy' : 'Copied'; }, 'btn small'); details.append(copy); }
      const raw = node('pre', 'raw-block', safeJSON(record)); raw.tabIndex = 0; details.append(raw); content.append(details);
    }
  }
  function selectCheck(checkId) { selectedCheck = (record.checks || []).find(check => check.id === checkId) || null; setTab('checks'); }
  for (const [key, label] of layers) {
    const button = action(label, () => setTab(key), 'evidence-tab'); button.id = `${id}-${key}`; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', id);
    button.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); const index = layers.findIndex(item => item[0] === key), next = event.key === 'Home' ? 0 : event.key === 'End' ? layers.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + layers.length) % layers.length; setTab(layers[next][0]); buttons.get(layers[next][0]).focus(); });
    buttons.set(key, button); tabs.append(button);
  }
  if (!buttons.has(currentTab)) currentTab = 'summary'; setTab(currentTab);
  return { setTab, selectCheck, getState: () => ({ tab: currentTab, selectedCheckId: selectedCheck?.id || null, selectedStep, recordId: record.runId }), destroy() { destroyed = true; } };
}
