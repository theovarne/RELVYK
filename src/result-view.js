import { formatAmount } from './solana/precision.js';
import { TOKEN_PROGRAM } from './solana/validation.js';

/**
 * @typedef {{kind: string, summary: Record<string, unknown>, raw?: unknown,
 * observedAt: string, dataSource: string, cached?: boolean, cacheAgeMs?: number,
 * comparison?: ResultObservation | null, comparisonStatus?: string,
 * comparisonReason?: string}} ResultObservation
 */

const UNKNOWN = 'Unknown — not returned';
const printable = value => value === null || value === undefined ? UNKNOWN : typeof value === 'string' ? value : typeof value === 'object' ? serialize(value) : String(value);
const serialize = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2) ?? 'null';
function node(tag, text = null, className = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== null) element.textContent = printable(text);
  return element;
}
function utc(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return UNKNOWN;
  return new Date(value).toISOString().replace('T', ' ').replace('Z', ' UTC');
}
function exactDisplay(raw, decimals, supplied) {
  if (supplied !== null && supplied !== undefined) return printable(supplied);
  if (raw === null || raw === undefined || !Number.isInteger(decimals)) return UNKNOWN;
  try { return formatAmount(raw, decimals); } catch { return UNKNOWN; }
}
function address(value) { return node('code', value, 'address mono'); }
function pill(text, status = '') { return node('span', text, `pill${status ? ' ' + status : ''}`); }
function note(parent, text, warning = false) { parent.append(node('p', text, `result-note${warning ? ' warning' : ''}`)); }
function section(parent, title) {
  const element = node('section', null, 'result-section');
  element.append(node('h4', title)); parent.append(element); return element;
}
function facts(parent, entries) {
  const list = node('dl', null, 'facts-grid');
  for (const [label, value, mono = false] of entries) {
    const item = node('div', null, 'fact'), definition = node('dd');
    item.append(node('dt', label));
    if (value instanceof Node) definition.append(value);
    else { definition.textContent = printable(value); if (mono) definition.className = 'mono'; }
    item.append(definition); list.append(item);
  }
  parent.append(list); return list;
}
function table(parent, labels, rows, className = 'data-table', empty = 'The source did not return records in this scope.') {
  if (!rows.length) { parent.append(node('p', empty, 'result-empty')); return null; }
  const wrapper = node('div', null, 'table-wrap'), grid = node('table', null, className);
  const header = node('thead'), heading = node('tr');
  for (const label of labels) { const cell = node('th', label); cell.scope = 'col'; heading.append(cell); }
  header.append(heading); grid.append(header);
  const body = node('tbody');
  for (const row of rows) {
    const line = node('tr');
    for (const value of row) {
      const cell = node('td');
      if (value instanceof Node) cell.append(value); else cell.textContent = printable(value);
      line.append(cell);
    }
    body.append(line);
  }
  grid.append(body); wrapper.append(grid); parent.append(wrapper); return grid;
}
function explorer(parent, url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'explorer.solana.com' || !/^\/(tx|address)\/[1-9A-HJ-NP-Za-km-z]+$/.test(parsed.pathname)) return;
    const link = node('a', 'Open in Solana Explorer', 'text-link');
    link.href = parsed.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; parent.append(link);
  } catch { /* Only known Explorer links are enabled. */ }
}
function copyButton(text, copyText) {
  const button = node('button', 'Copy', 'btn small'); button.type = 'button';
  button.addEventListener('click', async () => {
    try {
      if (typeof copyText === 'function') {
        const result = await copyText(text);
        if (result === false) throw new Error('Copy was not available.');
      } else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else throw new Error('Copy was not available.');
      button.textContent = 'Copied'; button.setAttribute('aria-label', 'Copied to clipboard');
    } catch { button.textContent = 'Retry copy'; button.setAttribute('aria-label', 'Copy failed. Try again.'); }
  });
  return button;
}
function rawBlock(parent, title, value, copyText, { text = false } = {}) {
  const content = text ? String(value ?? '') : serialize(value);
  const heading = node('div', null, 'raw-heading'); heading.append(node('h4', title), copyButton(content, copyText));
  const pre = node('pre', null, 'raw-block'); pre.tabIndex = 0; pre.setAttribute('aria-label', title);
  const code = node('code', content); pre.append(code); parent.append(heading, pre); return pre;
}
function sourceFacts(result) {
  return [
    ['Network', result.summary?.network],
    ['Source', result.dataSource],
    ['Read at', utc(result.observedAt)],
    ['Observation', result.cached ? `Cached source response · ${Math.max(0, result.cacheAgeMs || 0)} ms old when retrieved` : result.kind === 'comparison' ? 'Local comparison of recorded observations' : 'Public RPC read'],
  ];
}

export function availableTabs(result) {
  const labels = {
    transaction: [['overview', 'Overview'], ['instructions', 'Instructions'], ['balances', 'Balance Changes'], ['logs', 'Logs'], ['raw', 'Raw Data']],
    token: [['overview', 'Overview'], ['extensions', 'Extensions'], ['raw', 'Raw Data']],
    snapshot: [['overview', 'Overview'], ['comparison', 'Comparison'], ['accounts', 'Token Accounts'], ['raw', 'Raw Data']],
    comparison: [['overview', 'Overview'], ['comparison', 'Comparison'], ['raw', 'Raw Data']],
  };
  return (labels[result?.kind] || [['overview', 'Overview'], ['raw', 'Raw Data']]).map(([id, label]) => ({ id, label }));
}

function transactionOverview(parent, result, copyText) {
  const s = result.summary;
  if (s.taskStatus === 'incomplete') note(parent, 'The selected source did not return a complete transaction record. This result does not establish that the transaction never existed.', true);
  if (s.chainStatus === 'failed') note(parent, 'The chain transaction failed. This inspection records that outcome and can still complete successfully.', true);
  facts(parent, [
    ['Inspection', s.taskStatus === 'completed' ? 'Completed' : 'Limited source data'],
    ['Chain execution', s.chainStatus === 'failed' ? pill('Failed on chain', 'fail') : s.chainStatus === 'succeeded' ? 'Succeeded on chain' : UNKNOWN],
    ['Finality', s.finality === 'finalized' ? 'Finalized' : s.finality === 'confirmed' ? 'Confirmed' : s.finality === 'processed' ? 'Processed' : UNKNOWN],
    ['Finality basis', s.finalitySource || (s.finality === 'unknown' ? UNKNOWN : 'RPC signature status')],
    ['Slot', s.slot, true], ['Block time', utc(s.blockTime)], ['Transaction version', s.version, true],
    ['Fee', s.feeSOL !== null && s.feeSOL !== undefined ? `${s.feeSOL} SOL · ${s.feeLamports} lamports` : UNKNOWN, true],
    ...sourceFacts(result), ['Signature', address(s.signature || s.input)],
  ]);
  if (s.finality === 'confirmed') note(parent, 'Confirmed is distinct from finalized. Task completion does not promote transaction finality.');
  if (s.version === 1) {
    const config = s.transactionConfig;
    const resources = section(parent, 'Version 1 signed resource configuration');
    const configured = (name, unit = '') => config?.fieldStates?.[name] === 'unset' ? 'Explicitly unset (null)' : config?.fieldStates?.[name] === 'set' ? `${config[name]}${unit ? ' ' + unit : ''}` : UNKNOWN;
    facts(resources, [['Compute unit limit', configured('computeUnitLimit', 'CU'), true], ['Loaded account data limit', configured('loadedAccountsDataSizeLimit', 'bytes'), true], ['Requested heap size', configured('heapSize', 'bytes'), true], ['Priority fee · total', configured('priorityFee', 'lamports'), true], ['Priority fee · SOL', config?.fieldStates?.priorityFee === 'set' ? `${config.priorityFeeSOL} SOL` : config?.fieldStates?.priorityFee === 'unset' ? 'Explicitly unset (null)' : UNKNOWN, true], ['Address lookup tables', config?.noAddressLookupTables === true ? 'Not used by version 1' : 'Unexpected or unavailable references']]);
    note(resources, config?.limitation || 'Version 1 limits must be read from transactionConfig. ComputeBudget instructions do not configure these limits. Priority fee is a total in lamports, not a per-CU price.');
    if (!config?.present || !config?.fieldsComplete) note(resources, 'Complete signed resource configuration was not returned. Unknown fields are not replaced with inferred instruction settings.', true);
  }
  if (s.error !== null && s.error !== undefined) rawBlock(parent, 'Chain error', s.error, copyText);
  explorer(parent, s.explorerUrl);
  const accounts = section(parent, 'Related accounts');
  table(accounts, ['Index', 'Account', 'Signer', 'Access', 'Source'], (s.accounts || []).map(account => [account.index, address(account.address), account.signer === true ? 'Signer observed' : account.signer === false ? 'Not a signer' : UNKNOWN, account.writable === true ? 'Writable' : account.writable === false ? 'Read-only' : UNKNOWN, account.source]));
  note(accounts, s.executorLimitation || 'The controlling person or service is not identified from the public key alone.');
  const programs = section(parent, 'Observed program IDs');
  table(programs, ['Index', 'Program ID'], (s.programs || []).map((program, index) => [index + 1, address(program)]));
}
function transactionInstructions(parent, result, copyText) {
  const instructions = result.summary.instructions || [];
  if (!instructions.length) { note(parent, 'No instruction records were returned by this source.'); return; }
  const list = node('div', null, 'instruction-list');
  for (const instruction of instructions) {
    const detail = node('details', null, 'instruction-item');
    const position = instruction.level === 'inner' ? `Internal ${instruction.index + 1} · parent instruction ${instruction.parentIndex + 1}` : `Instruction ${instruction.index + 1}`;
    const heading = node('summary'); heading.append(node('span', position, 'mono'), node('strong', instruction.type || 'Unparsed instruction')); detail.append(heading);
    facts(detail, [['Program ID', address(instruction.programId)], ['Parser label', instruction.program], ['Level', instruction.level === 'inner' ? 'Internal instruction' : 'Top-level instruction'], ['Stack height', instruction.stackHeight]]);
    if (instruction.accounts?.length) table(detail, ['Referenced account'], instruction.accounts.map(account => [address(account)]));
    if (instruction.parsed) rawBlock(detail, 'RPC-parsed instruction', instruction.parsed, copyText);
    else {
      note(detail, instruction.limitation || 'This program was not parsed. Its purpose is not inferred.');
      if (instruction.data !== null && instruction.data !== undefined) rawBlock(detail, 'Original instruction payload (base58)', instruction.data, copyText, { text: true });
    }
    rawBlock(detail, 'Original instruction record', instruction.raw, copyText); list.append(detail);
  }
  parent.append(list);
  note(parent, 'Internal instructions are limited to the records supplied by the RPC source. Missing internal records are not reconstructed.');
}
function transactionBalances(parent, result) {
  const changes = result.summary.balanceChanges || {};
  const sol = section(parent, 'Native SOL balance changes');
  if (changes.solAvailable === false) note(sol, 'A required SOL balance array was not returned. Missing amounts remain unknown.', true);
  table(sol, ['Account', 'Before · SOL', 'After · SOL', 'Change · SOL'], (changes.sol || []).map(row => [address(row.account), exactDisplay(row.before, 9, row.formattedBefore), exactDisplay(row.after, 9, row.formattedAfter), exactDisplay(row.delta, 9, row.formattedDelta)]));
  const tokens = section(parent, 'Public Token balance changes');
  if (changes.tokensAvailable === false) note(tokens, 'One or both Token balance arrays were not supplied. Missing arrays are not zero balances.', true);
  table(tokens, ['Account', 'Mint', 'Token Program', 'Before', 'After', 'Change', 'Decimals'], (changes.tokens || []).map(row => [address(row.account), address(row.mint), address(row.program), exactDisplay(row.before, row.decimals, row.formattedBefore), exactDisplay(row.after, row.decimals, row.formattedAfter), exactDisplay(row.delta, row.decimals, row.formattedDelta), row.decimals]));
  note(parent, changes.limitation || 'Balance changes include fees, account creation or closure, and wrapped SOL. They do not identify buy/sell intent or investment profit.');
}
function authorityValue(value) {
  const wrapper = node('span', null, 'authority-value');
  if (value?.state === 'revoked') wrapper.append(pill('Confirmed revoked', 'pass'), node('span', 'Explicit null authority field'));
  else if (value?.state === 'present') wrapper.append(pill('Authority present', 'fail'), address(value.address));
  else wrapper.append(pill('Unknown', 'unknown'), node('span', 'Authority field was not read'));
  return wrapper;
}
function tokenOverview(parent, result) {
  const s = result.summary;
  if (s.isMint === false) note(parent, 'This response did not identify a supported Mint. Wallets and Token accounts cannot be used as Mint substitutes.', true);
  facts(parent, [
    ['Mint', address(s.mint || s.input)], ['Mint identity', s.isMint ? 'Token Program Mint observed' : 'Not established'],
    ['Token Program', s.programName], ['Program ID', address(s.programId)],
    ['Supply', s.supply, true], ['Supply · base units', s.supplyRaw, true], ['Decimals', s.decimals, true],
    ['Mint authority', authorityValue(s.mintAuthority)], ['Freeze authority', authorityValue(s.freezeAuthority)],
    ['Initialized', s.initialized === true ? 'Yes' : s.initialized === false ? 'No' : UNKNOWN], ['Context slot', s.slot, true],
    ...sourceFacts(result),
  ]);
  note(parent, s.readingScope || 'Mint fields and the defined control checks are inspected. No comprehensive security audit or market valuation is performed.');
  explorer(parent, s.explorerUrl);
  const metadata = section(parent, 'Metadata returned by the source');
  facts(metadata, [['Name', s.metadata?.name ?? s.name], ['Symbol', s.metadata?.symbol ?? s.symbol], ['Metadata URI · text only', s.metadata?.uri, true], ['Metadata source', s.metadata?.source]]);
  note(metadata, 'Metadata is untrusted text. Its HTML is not executed and external URLs are not fetched. A name or symbol does not establish authenticity.');
}
function tokenExtensions(parent, result, copyText) {
  const s = result.summary, extensions = s.extensions || [], binaryTypes = s.extensionTypes || [];
  note(parent, s.programId === TOKEN_PROGRAM ? 'This Mint uses the original Token Program. Token-2022 extension scope does not apply.' : s.extensionCoverage ? 'The binary extension inventory and the RPC-parsed entry count were read. Extension behavior remains outside the listed checks.' : 'Complete binary-to-parser coverage was not established. Unparsed extensions cannot be treated as harmless.', !s.extensionCoverage && s.programId !== TOKEN_PROGRAM);
  const parsed = section(parent, 'RPC-parsed extensions');
  if (!extensions.length) parsed.append(node('p', 'No parsed extension entries were returned.', 'result-empty'));
  for (const extension of extensions) {
    const item = node('details', null, 'instruction-item');
    item.append(node('summary', extension.name)); rawBlock(item, 'Extension state returned by RPC', extension.state, copyText); parsed.append(item);
  }
  const inventory = section(parent, 'Binary extension inventory');
  table(inventory, ['Type ID', 'Payload bytes', 'Offset', 'Reading'], binaryTypes.map(type => [type.typeId, type.byteLength, type.offset, type.label || 'Unparsed extension ID']));
  note(inventory, 'Type IDs are retained even when their behavior is not parsed. This inspector does not verify every transfer hook, fee rule, confidential balance, metadata authority, or extension interaction.');
}
function aggregateTable(parent, balances) {
  table(parent, ['Mint', 'Token Program', 'Recorded balance', 'Base units', 'Accounts'], (balances || []).map(row => [address(row.mint), address(row.program), exactDisplay(row.amount, row.decimals, row.formatted), row.amount, row.accountCount]));
}
function snapshotOverview(parent, result) {
  const s = result.summary;
  if (!s.complete) note(parent, 'This snapshot is partial. Missing source responses and excluded account records remain unknown.', true);
  facts(parent, [['Owner', address(s.owner || s.input)], ['SOL', s.solBalance === null || s.solBalance === undefined ? UNKNOWN : `${s.solBalance} SOL`, true], ['SOL · lamports', s.solLamports, true], ['Context slot', s.slot, true], ['Slot range', s.slotRange?.min && s.slotRange?.max ? `${s.slotRange.min}–${s.slotRange.max}` : UNKNOWN, true], ['Snapshot coverage', s.complete ? 'Returned public balance scope read' : 'Partial recorded scope'], ...sourceFacts(result)]);
  note(parent, s.scope);
  note(parent, 'SOL and the two Token Program account lists are separate confirmed reads. Their context slots are preserved; this is not an atomic historical balance.');
  if (result.comparisonStatus === 'baseline-created' || !result.comparison) note(parent, result.comparisonReason || 'This capture can be saved as a baseline. A comparison requires a second actual observation of the same owner and network.');
  const tokens = section(parent, 'Balances by Mint and Token Program'); aggregateTable(tokens, s.balances);
  if (s.errors?.length) table(section(parent, 'Scope limitations recorded'), ['Source', 'Finding'], s.errors.map(error => [error.source, error.message]));
  explorer(parent, s.explorerUrl);
}
function snapshotAccounts(parent, result) {
  const s = result.summary;
  table(parent, ['Token account', 'Mint', 'Token Program', 'Public base balance', 'State', 'Read slot'], (s.tokenAccounts || []).map(account => [address(account.address), address(account.mint), address(account.program), exactDisplay(account.amount, account.decimals, account.formatted), account.state, account.slot]));
  note(parent, s.scope);
  if (s.truncated) note(parent, `The recorded list reached the ${s.accountLimit || 2000}-account scope limit. This capture is partial.`, true);
}
function snapshotComparison(parent, result) {
  const comparison = result.kind === 'comparison' ? result : result.comparison;
  if (!comparison) {
    note(parent, result.comparisonReason || 'Create a baseline snapshot, then read the same account and network again to compare real saved observations.');
    return;
  }
  const s = comparison.summary;
  if (!s.complete) note(parent, 'A capture is partial. Missing balances are unknown and are not replaced with zero.', true);
  facts(parent, [['Owner', address(s.owner)], ['Network', s.network], ['Previous observation', utc(s.interval?.from)], ['Current observation', utc(s.interval?.to)], ['Interval', Number.isFinite(s.interval?.durationMs) ? `${s.interval.durationMs} ms between source observations` : UNKNOWN], ['SOL change', s.solChange?.formattedDelta === null || s.solChange?.formattedDelta === undefined ? UNKNOWN : `${s.solChange.formattedDelta} SOL`, true], ['Derivation', 'Local subtraction of recorded public balances']]);
  if (s.interval?.sameObservation) note(parent, 'The source observation times are identical. These captures may refer to the same cached read.', true);
  table(parent, ['Mint', 'Token Program', 'Previous', 'Current', 'Recorded change'], (s.changes || []).map(row => [address(row.mint), address(row.program), exactDisplay(row.before, row.decimals, row.formattedBefore), exactDisplay(row.after, row.decimals, row.formattedAfter), exactDisplay(row.delta, row.decimals, row.formattedDelta)]));
  note(parent, 'Differences reflect recorded balances. They do not reconstruct an arbitrary historical balance or establish investment profit.');
  note(parent, s.scope);
}

/**
 * Append safe DOM for the requested normalized result tab. No metadata executes.
 * @param {HTMLElement} container
 * @param {ResultObservation | null} result
 * @param {string} [tab]
 * @param {{copyText?: (text: string) => void | boolean | Promise<void | boolean>, exportJSON?: (value: unknown, name?: string) => void}} [options]
 */
export function renderResultView(container, result, tab = 'overview', { copyText, exportJSON } = {}) {
  container.replaceChildren();
  if (!result?.summary) { container.append(node('p', 'Run an inspection to view the returned evidence.', 'result-empty')); return container; }
  const validTab = availableTabs(result).some(item => item.id === tab) ? tab : 'overview';
  if (validTab === 'raw') {
    note(container, 'Original RPC evidence is retained. Unsafe numeric JSON integers are represented as exact decimal strings.');
    rawBlock(container, 'Raw source data', result.raw, copyText);
  } else if (result.kind === 'transaction') {
    if (validTab === 'instructions') transactionInstructions(container, result, copyText);
    else if (validTab === 'balances') transactionBalances(container, result);
    else if (validTab === 'logs') {
      if (result.summary.logsAvailable !== true || !Array.isArray(result.summary.logs)) note(container, 'The data source did not return log messages. Missing logs are not evidence of no activity.');
      else rawBlock(container, 'Transaction logs', result.summary.logs.join('\n'), copyText, { text: true });
    } else transactionOverview(container, result, copyText);
  } else if (result.kind === 'token') {
    if (validTab === 'extensions') tokenExtensions(container, result, copyText);
    else tokenOverview(container, result);
  } else if (result.kind === 'snapshot') {
    if (validTab === 'comparison') snapshotComparison(container, result);
    else if (validTab === 'accounts') snapshotAccounts(container, result);
    else snapshotOverview(container, result);
  } else if (result.kind === 'comparison') snapshotComparison(container, result);
  else rawBlock(container, 'Result summary', result.summary, copyText);
  // Export stays an explicit application control; rendering never downloads.
  void exportJSON;
  return container;
}

export function renderChecks(container, checks = []) {
  container.replaceChildren();
  table(container, ['Checked', 'Finding', 'Evidence', 'Limitation'], checks.map(check => {
    const checked = node('div', null, 'check-label');
    const status = ['pass', 'fail', 'unknown'].includes(check.status) ? check.status : 'unknown';
    checked.append(pill(status === 'pass' ? 'Checked' : status === 'fail' ? 'Finding' : 'Unknown', status), node('strong', check.label || check.title || 'Defined check'));
    return [checked, check.finding, Array.isArray(check.evidence) ? check.evidence.map(printable).join('\n') : printable(check.evidence), check.limitation || 'Limited to the evidence and rule listed here.'];
  }), 'checks-table', 'No check results were returned for this observation.');
  return container;
}
