import { brandConfig, tokenConfig, features, networks } from './src/config.js';
import { createEvidenceStore } from './src/evidence-store.js';
import { createTaskEngine, TASK_STAGES } from './src/task-engine.js';
import { createReflexLibrary, defaultTemplateFor } from './src/reflex-library.js';
import { createWalletService } from './src/wallet-service.js';
import { createEngineBlueprint } from './src/engine-blueprint.js';
import { createReplayController } from './src/replay-controller.js';
import { getRecordedExamples, loadRecordedExample } from './src/recorded-examples.js';
import { renderDossiers } from './src/reflex-dossiers.js';
import { renderEvidenceList, renderEvidenceDetail } from './src/evidence-panel.js';
import { createExperienceUI } from './src/experience-ui.js';
import { createModelController } from './src/model-controller.js';
import { createSessionObserver } from './src/session-observer.js';
import { createObservationQueue } from './src/observation-queue.js';
import { createShowcaseVisibilityBridge } from './src/showcase-lifecycle.js';
import { rpc, validateInput } from './src/solana/client.js';
import { renderResultView, renderChecks, availableTabs } from './src/result-view.js';
import { node, action, display, shortAddress, utc, safeExplorerURL, toast, copyText, exportJSON } from './src/ui-helpers.js';

/** @template {keyof import('./src/ui-types.js').UIElements} K @param {K} id @returns {import('./src/ui-types.js').UIElements[K]} */
const $ = id => /** @type {import('./src/ui-types.js').UIElements[K]} */ (document.getElementById(id));
const setText = (id, text) => { $(id).textContent = text === '' ? '' : display(text); };
const taskTabs = /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('[data-task]'));
const store = createEvidenceStore();
const engine = createTaskEngine({ store });
const library = createReflexLibrary({ store, engine });
const wallet = createWalletService();
const showcaseBridge = createShowcaseVisibilityBridge(document.querySelector('.hero-machine iframe'));
export const uiState = {
  taskType: 'transaction', inputs: { transaction: '', token: '', snapshot: '' },
  selectedStage: 'SENSE', manualStage: false, resultTab: 'overview', pendingTemplate: null,
  resultKey: null, lastRunId: null, libraryRevision: 0, evidenceRevision: 0,
  selectedRecord: null, deleteId: null, copySourceId: null, formRevision: 0,
  tourActive: false, replaySelecting: false, evidenceView: /** @type {'list'|'timeline'} */ ('list'), evidenceScroll: 0, selectedTemplate: null,
};
const taskLabels = { transaction: 'Transaction', token: 'Token anatomy', snapshot: 'Account snapshot' };
const taskForm = {
  transaction: { label: 'Transaction signature', placeholder: 'Paste a Solana transaction signature', help: 'A base58 signature that decodes to 64 bytes. Legacy, v0 and v1 transactions are supported.', button: 'Inspect transaction →' },
  token: { label: 'Mint address', placeholder: 'Paste a Solana Mint address', help: 'A 32-byte Solana Mint address. The account type and Token Program are checked before supply or controls are shown.', button: 'Inspect Mint →' },
  snapshot: { label: 'Public account address', placeholder: 'Paste a Solana account address', help: 'Capture public SOL and Token Account balances. A second saved capture compares the same account and network.', button: 'Create snapshot →' },
};
const partDetails = {
  SENSE: ['Optical assembly', 'Identify the input, selected network and data source before reading the chain.'],
  PLAN: ['Planning rotor', 'Choose a predefined read-only route and the explicit checks for this task type.'],
  AUTHORIZE: ['Permission lock', 'Confirm a bounded public read. No asset authorization or signature is requested.'],
  EXECUTE: ['Tool actuator', 'Read the selected RPC, parse the returned data and preserve original evidence.'],
  VERIFY: ['Verification gauge', 'Compare the response with defined checks. Missing data remains unknown.'],
  REMEMBER: ['Memory archive', 'Save the observation, checks and source in this browser for inspection and reuse.'],
};
let replay, experience, dossiers, evidencePanel;
function shownState() { return replay?.getState().presentation || engine.getState(); }
const model = createModelController({ onSelect(stage) {
  uiState.selectedStage = stage; uiState.manualStage = true;
  if (replay?.getState().active && !uiState.replaySelecting && !uiState.tourActive) {
    const index = replay.getState().record.stepRecords.findIndex(step => step.stage === stage);
    if (index >= 0) { replay.pause(); replay.seek(index); }
  }
  renderStages(shownState()); renderStage(shownState());
}, onHover(stage) {
  const selected = stage || model.getViewState().selectedStage, index = TASK_STAGES.indexOf(selected);
  $('part-hover').replaceChildren(node('span','mono',`${String(index+1).padStart(2,'0')} / ${selected}`),node('strong','',partDetails[selected][0]),node('span','',partDetails[selected][1]));
  for (const button of $('step-list').querySelectorAll('button')) button.classList.toggle('is-hovered',button.dataset.stage === stage);
} });
const blueprint = createEngineBlueprint({ container: $('engine-blueprint'), model });
experience = createExperienceUI({ model, workspace: $('engine-workspace'), onTourChange(active) {
  uiState.tourActive = active; if (active) replay?.stop(); renderStage(shownState());
} });
model.subscribe(view => {
  uiState.selectedStage = view.selectedStage; uiState.manualStage = view.manualSelection;
  $('explode-amount').value = String(Math.round(view.explodeAmount*100)); $('explode-value').value = `${Math.round(view.explodeAmount*100)}%`;
  setText('model-view-label',`${view.view.toUpperCase()} / ${view.focusedStage ? 'FOCUSED '+view.focusedStage : '2D ENGINEERING VIEW'}`);
  document.querySelectorAll('[data-model-view]').forEach(button => button.setAttribute('aria-pressed',String(button.getAttribute('data-model-view')===view.view)));
  $('engine-workspace').dataset.view = view.view;
  for (const button of $('step-list').querySelectorAll('button')) { button.classList.toggle('selected',button.dataset.stage===view.selectedStage); button.classList.toggle('is-hovered',button.dataset.stage===view.hoveredStage); }
  renderStage(shownState());
});
replay = createReplayController({ engine, onSelectStep(step,_index,presentation) {
  uiState.replaySelecting = true; uiState.selectedStage = step.stage; model.select(step.stage,{manual:!replay.getState().playing}); uiState.replaySelecting = false;
  renderEngine(presentation);
}, onChange(state) {
  $('replay-controls').hidden = !state.active;
  if (!state.active) return;
  setText('replay-label',state.label); setText('replay-pacing',state.pacing);
  setText('replay-play',state.playing ? 'Pause' : 'Play');
  $('replay-position').max = String(state.stepCount-1); $('replay-position').value = String(state.selectedStep);
  setText('replay-step-label',`${state.selectedStep+1} / ${state.stepCount} · ${state.step?.stage || ''}`);
  $('replay-prev').disabled=state.selectedStep<=0; $('replay-next').disabled=state.selectedStep>=state.stepCount-1;
} });
async function enterReplay(record,index=0) {
  experience.stopTour(); await replay.load(record); if(index)replay.seek(index);
  $('engine').scrollIntoView({behavior:'smooth',block:'start'});
}
function freshFromRecord(record) { replay.stop(); experience.stopTour(); focusInput(record.taskType,{input:record.input,network:record.network}); }
for (const example of getRecordedExamples()) {
  const card=node('article','recorded-example');card.append(node('p','eyebrow',`${example.label} / ${example.network}`),node('h4','',example.title),node('p','',example.description));
  const controls=node('div','example-actions');controls.append(action('Replay example →',async()=>enterReplay(await loadRecordedExample(example.id)),'text-button'),action('Inspect fresh',async()=>freshFromRecord(await loadRecordedExample(example.id)),'text-button'));card.append(controls);$('recorded-examples').append(card);
}

function fieldError(message) {
  $('input-error').hidden = !message; setText('input-error', message || '');
  $('task-input').setAttribute('aria-invalid', String(Boolean(message)));
}
/** @param {string} type @param {{input?:string,network?:string,templateId?:string}} [options] */
function changeTask(type, { input, network, templateId } = {}) {
  if (!taskForm[type]) return;
  uiState.formRevision++;
  if (engine.getState().status === 'running') engine.cancel();
  uiState.inputs[uiState.taskType] = $('task-input').value;
  uiState.taskType = type; uiState.pendingTemplate = templateId || null;
  if (input !== undefined) uiState.inputs[type] = input;
  if (network && networks.some(item => item.id === network)) $('network-select').value = network;
  $('task-input').value = uiState.inputs[type];
  for (const tab of taskTabs) {
    const selected = tab.dataset.task === type; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
  }
  setText('input-label', taskForm[type].label); setText('input-help', taskForm[type].help);
  $('task-input').placeholder = taskForm[type].placeholder; setText('submit-task', taskForm[type].button);
  $('wallet-use').hidden = type !== 'snapshot' || !wallet.getState().address;
  fieldError(null);
}
function focusInput(type = 'transaction', options = {}) {
  changeTask(type, options); $('inspect').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('task-input').focus({ preventScroll: true });
}
async function submitTask() {
  const type = uiState.taskType, network = $('network-select').value, templateId = uiState.pendingTemplate;
  const revision = uiState.formRevision, value = $('task-input').value, validation = validateInput(type, value);
  if (!validation.valid) { fieldError(validation.error); $('task-input').focus(); return; }
  fieldError(null); uiState.inputs[type] = validation.value;
  experience.stopTour(); replay.stop(); uiState.resultTab = 'overview';
  const template = templateId ? await library.get(templateId) : defaultTemplateFor(type);
  if (revision !== uiState.formRevision || uiState.taskType !== type || $('network-select').value !== network || $('task-input').value.trim() !== validation.value) return;
  $('engine').scrollIntoView({ behavior: 'smooth', block: 'start' });
  const completed = await engine.run({ type, input: validation.value, network, templateId: template?.id, templateVersion: template?.version });
  if (completed && revision === uiState.formRevision) { $('result-panel').classList.remove('result-arrived'); requestAnimationFrame(()=>$('result-panel').classList.add('result-arrived')); toast('Observation ready. Explore the result and its checks.'); if (!uiState.manualStage) $('result-panel').scrollIntoView({behavior:'smooth',block:'nearest'}); }
  await Promise.all([refreshLibrary(), refreshEvidence()]);
}

function renderStages(state) {
  const list = $('step-list'); list.replaceChildren();
  TASK_STAGES.forEach((stage, index) => {
    const record = state.stepRecords.find(item => item.stage === stage), item = node('li', 'task-step');
    const button = action('', () => { uiState.manualStage = true; uiState.selectedStage = stage; model.select(stage); renderStages(shownState()); renderStage(shownState()); }, 'step-button');
    button.dataset.stage=stage; button.classList.toggle('selected', stage === uiState.selectedStage); button.dataset.status = record?.status || 'ready';
    if (stage === uiState.selectedStage) button.setAttribute('aria-current', 'step');
    button.setAttribute('aria-label', `${stage}: ${record?.status || 'ready'}`);
    button.append(node('span', 'step-number', record?.status === 'complete' ? '✓' : String(index + 1).padStart(2, '0')));
    const label = node('div'); label.append(node('strong', 'step-label', stage), node('small', '', record?.status || ['Identify input', 'Choose the route', 'Read-only boundary', 'Read and parse', 'Defined checks', 'Local record'][index]));
    button.append(label); item.append(button); list.append(item);
  });
}
function renderStage(state) {
  const stage = uiState.selectedStage, index = TASK_STAGES.indexOf(stage), step = state.stepRecords.find(item => item.stage === stage);
  setText('detail-index', `${String(index + 1).padStart(2, '0')} / ${stage}`);
  setText('detail-title', partDetails[stage][0]); setText('detail-duty', partDetails[stage][1]);
  setText('detail-state', state.mode === 'replay' ? 'HISTORY' : step?.status?.toUpperCase() || 'READY');
  $('detail-state').className = `pill ${step?.status === 'complete' ? 'pass' : step?.status === 'failed' ? 'unknown' : 'neutral'}`;
  setText('detail-record', step?.summary || 'Submit an inspection to see its observed route.');
  setText('detail-time', step ? utc(step.completedAt || step.startedAt) : '');
  const box = $('stage-evidence'); box.replaceChildren();
  if (uiState.tourActive) { setText('detail-state','STRUCTURE TOUR'); setText('detail-record','Explore this assembly. No inspection is being started by this guide.');setText('detail-time','');box.append(action('Focus this assembly',()=>model.focus(stage),'button secondary')); return; }
  const io=node('details','stage-io');io.append(node('summary','','Input & output'));const facts=node('dl');
  for(const [label,value] of [['Input',state.task?.input || 'No task input selected'],['Network',state.task?.network || 'Choose in Inspect'],['Output',step?.summary || 'Explore the structure or start a task to observe this stage.']])facts.append(node('dt','',label),node('dd','mono',value));io.append(facts);box.append(io);

  if (stage === 'VERIFY') for (const check of state.checks.slice(0, 3)) {
    const row = node('div', 'stage-check'); row.append(node('span', `pill ${check.status}`, check.status === 'pass' ? 'CHECKED' : check.status === 'fail' ? 'FINDING' : 'UNKNOWN'), node('strong', '', check.label || check.title), node('p', '', check.finding)); box.append(row);
  }
  else if (stage === 'EXECUTE') for (const ref of (state.result?.evidenceRefs || []).slice(0, 3)) {
    const row = node('div', 'stage-check'); row.append(node('strong', 'mono', ref.method || ref.id), node('p', '', `${ref.dataSource || state.result.dataSource} · ${utc(ref.observedAt || state.result.observedAt)}`)); box.append(row);
  }
  else if (stage === 'REMEMBER') { box.append(node('p','small-note',state.record?.recordKind === 'RecordedExample' ? 'Packaged historical example. No new record has been saved.' : state.record ? `Recorded observation ${state.record.runId}` : store.status.message)); if(state.record)box.append(action('Open observation file ↗',()=>openRecord(state.record),'text-button')); }
  if (state.record && stage !== 'REMEMBER') box.append(action('Open stage evidence ↗', async()=>{await openRecord(state.record);evidencePanel.setTab(stage==='VERIFY'?'checks':'steps');},'text-button'));
}
function renderEngine(state) {
  if (uiState.lastRunId !== state.runId) { uiState.lastRunId = state.runId; uiState.resultTab = 'overview'; }
  if (!uiState.manualStage && TASK_STAGES.includes(state.stage)) uiState.selectedStage = state.stage;
  const replay = state.mode === 'replay';
  const status = replay ? 'Historical replay' : { idle: 'Awaiting input', running: `Processing / ${state.stage}`, complete: state.result?.summary?.taskStatus === 'incomplete' ? 'Observation incomplete' : 'Inspection complete', error: 'Read could not complete', cancelled: 'Query cancelled' }[state.status] || 'Awaiting input';
  setText('task-status', status); setText('task-mode', replay ? 'SAVED OBSERVATION · NO NEW RPC QUERY' : 'READ-ONLY WORKBENCH');
  const limited = state.result?.summary?.taskStatus === 'incomplete' || state.checks.some(check => check.status !== 'pass');
  $('task-status-dot').style.background = state.status === 'error' || limited ? 'var(--accent-warning)' : state.status === 'complete' ? 'var(--accent-success)' : 'var(--accent-primary)';
  setText('run-id', state.runId || 'NO ACTIVE QUERY');
  setText('input-summary-type', state.task ? taskLabels[state.task.type] : 'Choose an inspection');
  setText('input-summary-value', state.task?.input || 'Transaction / Token / Snapshot');
  setText('input-summary-network', state.task ? `${state.task.network} · ${replay ? 'historical observation' : 'user-requested public read'}` : 'No query has been made.');
  $('cancel-task').hidden = state.status !== 'running'; $('submit-task').disabled = state.status === 'running';
  setText('submit-task', state.status === 'running' ? 'Reading the chain…' : taskForm[uiState.taskType].button);
  model.setTaskState(state); renderStages(state); renderStage(state);
  const key = `${state.runId}:${state.status}:${state.result ? 'result' : 'none'}:${replay}`;
  if (uiState.resultKey !== key) { uiState.resultKey = key; renderResult(state); }
}
function renderResult(state) {
  const record = state.record, result = state.result;
  $('result-panel').hidden = !result && !state.error;
  if (!result && !state.error) return;
  setText('result-kind', `${record?.taskType || state.task?.type || 'OBSERVATION'} / ${state.mode === 'replay' ? 'SAVED HISTORY' : 'READ-ONLY QUERY'}`);
  setText('result-title', state.error ? 'The source could not complete this read.' : result.summary?.taskStatus === 'incomplete' ? 'An observation with unavailable fields.' : `${taskLabels[record?.taskType || state.task?.type]} / parsed evidence`);
  setText('result-source', result ? `${result.dataSource} · observed ${utc(result.observedAt)}${result.cached ? ` · cached observation (${result.cacheAgeMs || 0} ms old)` : ''} · ${!record ? 'saving local record' : record.recordKind === 'RecordedExample' ? 'packaged Recorded Example' : record.storageScope === 'memory' ? 'page-session record' : 'saved in this browser'}` : state.error.message);
  const explorer = safeExplorerURL(result?.summary?.explorerUrl); $('result-explorer').hidden = !explorer;
  if (explorer) $('result-explorer').href = explorer;
  else $('result-explorer').removeAttribute('href');
  $('save-result-reflex').hidden = !result || !record || record.recordKind === 'RecordedExample'; $('export-result').hidden = !record;
  $('result-tabs').replaceChildren(); $('result-content').replaceChildren();
  if (state.error && !result) {
    $('result-content').append(node('p', 'note-box warning', `${state.error.message} Your input has been retained. No chain result has been invented.`), action('Retry query →', () => {
      const failed = state.task || { type: record?.taskType, input: record?.input, network: record?.network };
      if (failed.type) changeTask(failed.type, { input: failed.input, network: failed.network });
      return submitTask();
    }, 'button primary'));
    renderChecks($('result-checks'), state.checks); return;
  }
  const tabs = availableTabs(result);
  if (!tabs.some(tab => tab.id === uiState.resultTab)) uiState.resultTab = tabs[0].id;
  for (const tab of tabs) {
    const button = action(tab.label, () => { uiState.resultTab = tab.id; renderResult(shownState()); });
    button.id = `result-tab-${tab.id}`; button.dataset.resultTab = tab.id;
    button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', 'result-content'); button.setAttribute('aria-selected', String(tab.id === uiState.resultTab)); button.tabIndex = tab.id === uiState.resultTab ? 0 : -1;
    $('result-tabs').append(button);
  }
  renderResultView($('result-content'), result, uiState.resultTab, { copyText, exportJSON }); renderChecks($('result-checks'), state.checks);
  $('result-content').setAttribute('role', 'tabpanel'); $('result-content').setAttribute('aria-labelledby', `result-tab-${uiState.resultTab}`);
}
async function refreshLibrary() {
  const revision=++uiState.libraryRevision;
  const templates=await library.list({search:$('reflex-search').value,type:$('reflex-filter').value}); if(revision!==uiState.libraryRevision)return;
  setText('template-count',(await library.list()).length);
  setText('reflex-filter-state',`${templates.length} matching workflows${$('reflex-search').value ? ' · '+$('reflex-search').value : ''} · ${$('reflex-filter').selectedOptions[0].textContent}`);
  dossiers?.destroy();
  dossiers=renderDossiers($('reflex-list'),templates,{selectedId:uiState.selectedTemplate,onSelect(template){uiState.selectedTemplate=template.id;},
    onRun:async template=>{const values=template.parameters||{};focusInput(template.type,{input:values.input,network:values.network,templateId:template.id});if(values.input)await submitTask();else toast(`Enter a ${taskForm[template.type].label.toLowerCase()} to run this Reflex.`);},
    onCopy:template=>openCopy(template.id),getRecords:template=>library.recentRecords(template.id),onRecord:openRecord,onError:error=>toast(error.message)});
}
async function openCopy(id) {
  const source = await library.get(id); if (!source) return toast('This workflow is no longer available.');
  uiState.copySourceId = id; $('reflex-title').value = `${source.title} · saved parameters`;
  $('reflex-input').value = source.parameters?.input || (source.type === uiState.taskType ? $('task-input').value : '');
  $('reflex-network').value = source.parameters?.network || $('network-select').value;
  $('reflex-copy-error').hidden = true; $('reflex-dialog').showModal();
}
async function refreshEvidence() {
  const revision = ++uiState.evidenceRevision, filter = $('evidence-filter').value, period = $('evidence-time').value;
  const records = await store.listRecords(); if (revision !== uiState.evidenceRevision) return;
  const threshold = period === 'day' ? Date.now() - 86400000 : period === 'week' ? Date.now() - 604800000 : 0;
  const rows = records.filter(record => (filter === 'all' || record.taskType === filter) && Date.parse(record.completedAt) >= threshold);
  setText('evidence-filter-state',`${rows.length} observations · ${$('evidence-filter').selectedOptions[0].textContent} · ${$('evidence-time').selectedOptions[0].textContent}`);
  renderEvidenceList($('evidence-list'),rows,{view:uiState.evidenceView,onOpen:openRecord,selectedId:uiState.selectedRecord?.runId});
}
async function openRecord(record) {
  uiState.selectedRecord=record;uiState.evidenceScroll=window.scrollY;evidencePanel?.destroy();
  evidencePanel=renderEvidenceDetail($('evidence-detail'),record,{copyText,onReplay:async item=>{$('evidence-drawer').close();await enterReplay(item);},
    onStep:async(item,_step,index)=>{$('evidence-drawer').close();await enterReplay(item,index);},onExport:item=>exportJSON(item,item.runId),
    onDelete:record.recordKind==='RecordedExample'?undefined:item=>{uiState.deleteId=item.runId;$('delete-dialog').showModal();}});
  if(!$('evidence-drawer').open)$('evidence-drawer').showModal();
}

function renderWallet(state) {
  $('wallet-trigger').textContent = state.address ? shortAddress(state.address) : state.status === 'connecting' ? 'Connecting…' : 'Connect wallet ↗';
  $('wallet-use').hidden = uiState.taskType !== 'snapshot' || !state.address;
  const list = $('wallet-list'); list.replaceChildren();
  const providers = wallet.getWallets();
  if (!providers.length) list.append(node('p', 'note-box', 'No compatible Solana wallet was detected. Open this page in a browser with a Wallet Standard wallet installed. All public inspections remain available.'));
  for (const provider of providers) {
    const button = action(provider.name, () => wallet.connect(provider.id), 'wallet-choice');
    const walletChain = state.network === 'mainnet-beta' ? 'solana:mainnet' : `solana:${state.network}`;
    button.append(node('small', '', provider.chains.includes(walletChain) ? 'Connect address' : 'Network support varies')); button.disabled = state.status === 'connecting'; list.append(button);
  }
  const account = $('wallet-account'); account.hidden = !state.address; account.replaceChildren();
  if (state.address) {
    account.append(node('p', 'eyebrow', `${state.walletName} / ${state.network}`), node('code', '', state.address));
    if (!state.supportsNetwork) account.append(node('p', 'small-note', 'This connected account does not advertise support for the selected network. Public inspections still work.'));
    const actions = node('div', 'account-actions'); actions.append(action('Copy address', () => copyText(state.address)), action('Disconnect', () => wallet.disconnect())); account.append(actions);
  }
  $('wallet-error').hidden = !state.error; setText('wallet-error', state.error?.message || '');
}
function initializeTokenObserver() {
  if (!features.projectTokenObserver || !tokenConfig.mint || !validateInput('token', tokenConfig.mint).valid) return;
  const section = $('project-token'); section.hidden = false;
  section.append(node('p', 'section-index', 'PROJECT TOKEN / EXPLICIT ACCOUNT SCOPE'), node('h2', '', 'Observe a defined account scope.'), node('p', '', 'This page session checks at most three selected accounts for new signatures. Only parsed instructions or Token balance evidence matching the confirmed project Mint are included. It does not cover every wallet, pool or trade.'), node('code', '', tokenConfig.mint));
  const form = node('form', 'observer-form'), label = node('label', '', 'Public account addresses (one per line, maximum three)'), input = node('textarea'); input.rows = 3; input.id = 'observer-accounts'; label.htmlFor = input.id; input.required = true;
  let sessionActive = false;
  const start = node('button', 'button primary', 'Start session observation'); start.type = 'submit'; const stop = action('Stop observation', () => { sessionActive = false; queue.stop(); observer.stop(); });
  const output = node('div', 'observer-output'); form.append(label, input, start, stop); section.append(form, output);
  const observer = createSessionObserver({ tokenConfig, rpc });
  const queue = createObservationQueue({ engine, onComplete: async () => { await Promise.all([refreshLibrary(), refreshEvidence()]); } });
  form.addEventListener('submit', event => { event.preventDefault(); sessionActive = true; queue.start(); observer.start({ accounts: input.value.split(/\s+/).filter(Boolean) }).catch(error => { sessionActive = false; queue.stop(); toast(error.message); }); });
  observer.subscribe(state => {
    if (!['disabled', 'stopped', 'limited', 'error'].includes(state.status)) queue.enqueue(state.events || []);
    const queued = queue.getState();
    output.replaceChildren(node('p', 'small-note', `${state.status} · current page session · ${state.accounts.length} selected accounts · last read ${utc(state.lastReadAt)}`));
    output.append(node('p', 'small-note', `${state.scope} ${state.coverage} ${state.limitation}`));
    for (const gap of [...state.gaps, ...queued.gaps.map(entry => entry.message)]) output.append(node('p', 'note-box warning', gap));
    if (state.error) output.append(node('p', 'form-error', state.error.message));
    for (const entry of state.events || []) output.append(action(`${shortAddress(entry.signature)} · ${entry.kind || 'Mint observation'} · ${entry.finality || 'confirmation unknown'}`, () => { focusInput('transaction', { input: entry.signature, network: tokenConfig.network }); return submitTask(); }));
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) queue.stop(); else if (sessionActive) queue.start(); });
  window.addEventListener('pagehide', event => { queue.stop(); if (!event.persisted) { observer.destroy(); queue.destroy(); } });
}

document.querySelectorAll('[data-start-inspect]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); focusInput(); }));
taskTabs.forEach(tab => {
  tab.addEventListener('click', () => changeTask(tab.dataset.task));
  tab.addEventListener('keydown', event => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const list = [...taskTabs], index = list.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
    changeTask(list[next].dataset.task); list[next].focus();
  });
});
$('task-form').addEventListener('submit', event => { event.preventDefault(); submitTask().catch(error => toast(error.message)); });
$('result-tabs').addEventListener('keydown', event => {
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
  const list = [...$('result-tabs').querySelectorAll('button')], index = list.indexOf(/** @type {HTMLButtonElement} */ (event.target));
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
  uiState.resultTab = list[next].dataset.resultTab; renderResult(shownState());
  /** @type {HTMLButtonElement} */ ($('result-tabs').querySelector(`button[data-result-tab="${uiState.resultTab}"]`)).focus();
});
$('task-input').addEventListener('input', () => { uiState.formRevision++; uiState.inputs[uiState.taskType] = $('task-input').value; if (engine.getState().status === 'running') engine.cancel(); fieldError(null); });
$('network-select').addEventListener('change', () => { uiState.formRevision++; engine.cancel(); wallet.setNetwork($('network-select').value); fieldError(null); });
$('cancel-task').addEventListener('click', () => engine.cancel());
$('wallet-trigger').addEventListener('click', () => { renderWallet(wallet.getState()); $('wallet-dialog').showModal(); });
$('wallet-use').addEventListener('click', () => { const address = wallet.getState().address; if (address) { $('task-input').value = address; $('task-input').dispatchEvent(new Event('input', { bubbles: true })); } });
document.querySelectorAll('.dialog-close').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog && (event.clientX < dialog.getBoundingClientRect().left || event.clientX > dialog.getBoundingClientRect().right || event.clientY < dialog.getBoundingClientRect().top || event.clientY > dialog.getBoundingClientRect().bottom)) dialog.close(); }));
$('reflex-copy-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { await library.saveCopy(uiState.copySourceId, { title: $('reflex-title').value, input: $('reflex-input').value, network: $('reflex-network').value }); $('reflex-dialog').close(); await refreshLibrary(); toast(store.status.persistent ? 'Reflex parameters saved in this browser.' : 'Reflex parameters saved in this page session.'); }
  catch (error) { $('reflex-copy-error').hidden = false; setText('reflex-copy-error', error.message); }
});
$('save-result-reflex').addEventListener('click', () => { const record = engine.getState().record; if (record) { changeTask(record.taskType, { input: record.input, network: record.network }); openCopy(record.templateId || defaultTemplateFor(record.taskType).id); } });
$('export-result').addEventListener('click', () => { const record = engine.getState().record; if (record) exportJSON(record, record.runId); });
$('reflex-search').addEventListener('input', () => refreshLibrary().catch(error => toast(error.message)));
$('reflex-filter').addEventListener('change', () => refreshLibrary().catch(error => toast(error.message)));
$('evidence-filter').addEventListener('change', () => refreshEvidence().catch(error => toast(error.message)));
$('evidence-time').addEventListener('change', () => refreshEvidence().catch(error => toast(error.message)));
document.querySelector('[data-delete-cancel]').addEventListener('click', () => $('delete-dialog').close());
$('confirm-delete').addEventListener('click', async () => { if (!uiState.deleteId) return; await store.deleteRecord(uiState.deleteId); $('delete-dialog').close(); $('evidence-drawer').close(); uiState.selectedRecord = null; await Promise.all([refreshEvidence(), refreshLibrary()]); toast('Local record and its captured snapshot deleted.'); });
const menu = document.querySelector('.menu-toggle');
menu.addEventListener('click', () => { const open = menu.getAttribute('aria-expanded') !== 'true'; menu.setAttribute('aria-expanded', String(open)); $('site-nav').classList.toggle('open', open); });
document.querySelectorAll('#site-nav a').forEach(link => link.addEventListener('click', () => { menu.setAttribute('aria-expanded', 'false'); $('site-nav').classList.remove('open'); }));
const navigation = new IntersectionObserver(entries => { for (const entry of entries.filter(item => item.isIntersecting)) for (const link of document.querySelectorAll('#site-nav a')) link.classList.toggle('active', link.getAttribute('href') === `#${entry.target.id}`); }, { rootMargin: '-15% 0px -65%' });
document.querySelectorAll('main>section[id]').forEach(section => navigation.observe(section));
wallet.subscribe(renderWallet); store.subscribeStatus(status => setText('storage-status', status.message)); engine.subscribe(renderEngine);
await store.ready; await Promise.all([refreshLibrary(), refreshEvidence()]); changeTask('transaction'); initializeTokenObserver();
document.querySelectorAll('[data-model-view]').forEach(button=>button.addEventListener('click',()=>model.setView(button.getAttribute('data-model-view'))));
$('explode-amount').addEventListener('input',()=>model.setExplodeAmount(Number($('explode-amount').value)/100));
$('focus-part').addEventListener('click',()=>model.focus());
$('replay-play').addEventListener('click',()=>replay.getState().playing?replay.pause():replay.play());
$('replay-prev').addEventListener('click',()=>replay.step(-1));$('replay-next').addEventListener('click',()=>replay.step(1));
$('replay-position').addEventListener('input',()=>replay.seek(Number($('replay-position').value)));
$('replay-speed').addEventListener('change',()=>replay.setSpeed(Number($('replay-speed').value)));
$('replay-fresh').addEventListener('click',()=>{const record=replay.getState().record;if(record)freshFromRecord(record);});
$('clear-reflex-filters').addEventListener('click',()=>{$('reflex-search').value='';$('reflex-filter').value='all';refreshLibrary();});
$('clear-evidence-filters').addEventListener('click',()=>{$('evidence-filter').value='all';$('evidence-time').value='all';refreshEvidence();});
document.querySelectorAll('[data-evidence-view]').forEach(button=>button.addEventListener('click',()=>{uiState.evidenceView=button.getAttribute('data-evidence-view')==='timeline'?'timeline':'list';document.querySelectorAll('[data-evidence-view]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));refreshEvidence();}));
$('evidence-drawer').addEventListener('close',()=>{if(!experience.getState().expanded)window.scrollTo({top:uiState.evidenceScroll,behavior:'instant'});});
document.addEventListener('visibilitychange',()=>{if(document.hidden)replay.pause();});
document.title = `${brandConfig.name} — ${brandConfig.description}`;
window.addEventListener('pagehide', event => { engine.cancel(); if (!event.persisted) { replay.destroy();experience.destroy();blueprint.destroy();dossiers?.destroy();evidencePanel?.destroy();model.destroy(); wallet.destroy(); showcaseBridge.destroy(); navigation.disconnect(); } });
