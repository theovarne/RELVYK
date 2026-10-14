import { rpc as solanaRpc } from './solana/transport.js';
import { validateInput } from './solana/validation.js';

/**
 * Bounded foreground-session observation of explicitly selected accounts.
 * A configured project mint is required. This is not a network-wide token feed.
 * https://solana.com/docs/rpc/http/getsignaturesforaddress
 */
const MAX_ACCOUNTS = 3;
const BATCH_SIZE = 20;
const MAX_EVENTS = 200;

export function observerEventKey(event) {
  return `${event.network}:${event.signature}:${event.index}:${event.kind}`;
}

function instructionProgram(instruction, accountKeys) {
  if (typeof instruction?.programId === 'string') return instruction.programId;
  const key = accountKeys?.[instruction?.programIdIndex];
  return typeof key === 'string' ? key : key?.pubkey || null;
}

/** Derive observations only from fields returned by RPC, never infer buys/sells. */
export function deriveMintEvents(transaction, { mint, network, signature, account, finality, observedAt }) {
  if (!transaction?.transaction?.message || !transaction?.meta) return [];
  const message = transaction.transaction.message;
  const events = [];
  const base = { network, signature, account, mint, finality, slot: transaction.slot ?? null,
    blockTime: transaction.blockTime ?? null, observedAt, chainError: transaction.meta.err ?? null,
    trigger: 'observed-account-activity', source: 'getTransaction', storageScope: 'page-session' };
  const instructions = (message.instructions || []).map((instruction, index) => ({ instruction, index: `outer:${index}` }));
  for (const group of transaction.meta.innerInstructions || []) {
    for (const [index, instruction] of (group.instructions || []).entries()) {
      instructions.push({ instruction, index: `inner:${group.index}:${index}` });
    }
  }
  for (const { instruction, index } of instructions) {
    if (instruction?.parsed?.info?.mint !== mint) continue;
    events.push({ ...base, index, kind: 'mint-instruction',
      programId: instructionProgram(instruction, message.accountKeys),
      instructionType: typeof instruction.parsed.type === 'string' ? instruction.parsed.type : 'parsed instruction',
      evidence: { path: index, parsed: instruction.parsed } });
  }
  const pre = new Map((transaction.meta.preTokenBalances || []).filter(balance => balance.mint === mint)
    .map(balance => [balance.accountIndex, balance]));
  const post = new Map((transaction.meta.postTokenBalances || []).filter(balance => balance.mint === mint)
    .map(balance => [balance.accountIndex, balance]));
  for (const accountIndex of new Set([...pre.keys(), ...post.keys()])) {
    const before = pre.get(accountIndex);
    const after = post.get(accountIndex);
    const preAmount = before?.uiTokenAmount?.amount ?? null;
    const postAmount = after?.uiTokenAmount?.amount ?? null;
    if (preAmount === postAmount) continue;
    events.push({ ...base, index: `balance:${accountIndex}`, kind: 'mint-balance-change', programId: after?.programId || before?.programId || null,
      evidence: { accountIndex, preAmount, postAmount,
        decimals: after?.uiTokenAmount?.decimals ?? before?.uiTokenAmount?.decimals ?? null,
        owner: after?.owner || before?.owner || null,
        limitation: 'A balance change does not establish a buy, sell, or investment return. A missing balance is unknown, not zero.' } });
  }
  return events;
}

export function createSessionObserver({ tokenConfig = { mint: null, network: 'mainnet-beta' }, rpc = solanaRpc,
  intervalMs = 15_000, target = globalThis.document, setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout, now = () => new Date().toISOString() } = {}) {
  const network = tokenConfig.network || 'mainnet-beta';
  const validatedMint = validateInput('token', tokenConfig.mint);
  const configured = Boolean(tokenConfig.mint && validatedMint.valid);
  const mint = configured ? validatedMint.value : null;
  const subscribers = new Set();
  const cursors = new Map();
  const pending = new Map();
  const events = new Map();
  const processed = new Set();
  let timer = null;
  let controller = null;
  let generation = 0;
  let failures = 0;
  let active = false;
  let destroyed = false;
  let inFlight = null;
  let state = { status: configured ? 'stopped' : 'disabled', mint, network, accounts: [],
    startedAt: null, lastReadAt: null, error: null, gaps: [],
    scope: 'Selected accounts, current foreground page session only.',
    coverage: 'New activity after the initial cursor. No all-wallet, all-pool, or buy/sell coverage.',
    limitation: 'Only RPC-parsed mint instructions and reported token balance changes are classified; unparsed instruction relevance may be unknown.',
    limits: { accounts: MAX_ACCOUNTS, signaturesPerAccount: BATCH_SIZE, events: MAX_EVENTS } };

  function getState() {
    return { ...state, accounts: [...state.accounts], gaps: [...state.gaps], limits: { ...state.limits },
      error: state.error ? { ...state.error } : null, cursors: Object.fromEntries(cursors),
      events: [...events.values()].map(event => ({ ...event, evidence: JSON.parse(JSON.stringify(event.evidence)) })),
      pendingCount: pending.size };
  }

  function emit() {
    if (destroyed) return;
    const snapshot = getState();
    for (const listener of subscribers) { try { listener(snapshot); } catch { /* Continue observer updates. */ } }
  }

  function schedule() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (!active || destroyed || target?.hidden || state.status === 'limited') return;
    const delay = Math.min(120_000, Math.max(10_000, intervalMs) * 2 ** Math.min(failures, 3));
    timer = setTimer(() => { timer = null; void poll(); }, delay);
  }

  function addGap(message) {
    if (!state.gaps.includes(message)) state = { ...state, gaps: [...state.gaps, message].slice(-10) };
  }

  function boundedError(error) {
    const rateLimited = error?.status === 429 || error?.code === 'RATE_LIMITED' || /rate|429/i.test(String(error?.message));
    return { code: rateLimited ? 'RATE_LIMITED' : 'SOURCE_UNAVAILABLE',
      message: rateLimited ? 'The data source limited this session. Observation will retry with backoff.'
        : 'The data source could not complete this read. The saved session cursor will be used on retry.' };
  }

  async function readSession(currentGeneration, signal) {
    const isCurrent = () => active && !destroyed && currentGeneration === generation && !signal.aborted;
    for (const account of state.accounts) {
      const cursor = cursors.get(account);
      const options = { limit: BATCH_SIZE, commitment: 'confirmed', ...(cursor && cursor !== 'empty-baseline' ? { until: cursor } : {}) };
      const signatures = await rpc('getSignaturesForAddress', [account, options], network, { signal });
      if (!isCurrent()) return;
      if (!Array.isArray(signatures)) throw new Error('Malformed signatures response.');
      if (!cursor) {
        // An empty first page is still a baseline; later arrivals are observable.
        cursors.set(account, signatures[0]?.signature || 'empty-baseline');
        continue;
      }
      if (signatures.length >= BATCH_SIZE) addGap(`The ${account} read reached the ${BATCH_SIZE}-signature cap; activity between reads may be incomplete.`);
      for (const item of signatures.slice().reverse()) {
        if (!validateInput('transaction', item?.signature).valid || item.signature === cursor) continue;
        const key = `${network}:${item.signature}`;
        if (processed.has(key) || pending.has(key)) continue;
        if (pending.size >= 100) {
          addGap('The 100-signature pending limit was reached; additional transaction relevance could not be read.');
          continue;
        }
        pending.set(key, { ...item, account, attempts: 0 });
      }
      if (signatures[0]?.signature) cursors.set(account, signatures[0].signature);
    }

    // At most 20 detailed reads per cycle, including retry candidates.
    for (const [key, item] of [...pending.entries()].slice(0, BATCH_SIZE)) {
      let transaction;
      try {
        transaction = await rpc('getTransaction', [item.signature,
          { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }], network, { signal });
      } catch (error) {
        if (!isCurrent()) return;
        item.attempts += 1;
        if (item.attempts >= 3) {
          pending.delete(key);
          processed.add(key);
          addGap('Some observed transactions could not be read after three attempts. Their token relevance remains unknown.');
        }
        throw error;
      }
      if (!isCurrent()) return;
      if (!transaction) {
        item.attempts += 1;
        if (item.attempts >= 3) {
          pending.delete(key);
          processed.add(key);
          addGap('Some observed signatures did not return transaction data within three reads. Their token relevance remains unknown.');
        }
        continue;
      }
      if (!transaction?.transaction?.message || !transaction?.meta) {
        addGap('A transaction response lacked its message or execution metadata; its token relevance remains unknown.');
      }
      const derived = deriveMintEvents(transaction, { mint, network, signature: item.signature, account: item.account,
        finality: item.confirmationStatus === 'finalized' ? 'finalized' : 'confirmed', observedAt: now() });
      for (const event of derived) {
        const unique = observerEventKey(event);
        if (!events.has(unique) && events.size < MAX_EVENTS) events.set(unique, event);
      }
      pending.delete(key);
      processed.add(key);
      if (events.size >= MAX_EVENTS || processed.size >= 500) {
        state = { ...state, status: 'limited' };
        addGap('The bounded session record limit was reached. Export or review these observations before beginning another session.');
        active = false;
        break;
      }
    }

    // Finality changes update existing observations; they never create a new event.
    const needsFinality = [...new Set([...events.values()].filter(event => event.finality !== 'finalized').map(event => event.signature))].slice(0, BATCH_SIZE);
    if (needsFinality.length && isCurrent()) {
      const statuses = await rpc('getSignatureStatuses', [needsFinality, { searchTransactionHistory: false }], network, { signal });
      if (!isCurrent()) return;
      if (!Array.isArray(statuses?.value)) throw new Error('Malformed signature status response.');
      needsFinality.forEach((signature, index) => {
        const status = statuses.value[index];
        if (status?.confirmationStatus !== 'finalized') return;
        for (const event of events.values()) if (event.signature === signature) {
          event.finality = 'finalized';
          event.finalityObservedAt = now();
        }
      });
    }
    if (currentGeneration === generation && !destroyed && !signal.aborted) {
      failures = 0;
      state = { ...state, status: state.status === 'limited' ? 'limited' : 'observing', lastReadAt: now(), error: null };
      emit();
    }
  }

  async function poll() {
    if (!configured || !active || destroyed || target?.hidden) return getState();
    if (inFlight) return inFlight;
    const currentGeneration = generation;
    const currentController = new AbortController();
    controller = currentController;
    state = { ...state, status: 'reading' };
    emit();
    inFlight = (async () => {
      try { await readSession(currentGeneration, currentController.signal); }
      catch (error) {
        if (active && !destroyed && currentGeneration === generation && !currentController.signal.aborted) {
          failures += 1;
          state = { ...state, status: 'retrying', error: boundedError(error) };
          emit();
        }
      } finally {
        if (currentGeneration === generation) {
          inFlight = null;
          controller = null;
          schedule();
        }
      }
      return getState();
    })();
    return inFlight;
  }

  function stop() {
    active = false;
    ++generation;
    if (timer !== null) clearTimer(timer);
    timer = null;
    controller?.abort();
    controller = null;
    inFlight = null;
    if (configured) state = { ...state, status: 'stopped' };
    emit();
    return getState();
  }

  /** @param {{accounts?: string[]}} options */
  async function start({ accounts } = {}) {
    if (destroyed) throw new Error('Observer has been disposed.');
    if (!configured) {
      state = { ...state, status: 'disabled', error: { code: 'MINT_NOT_CONFIGURED', message: 'A confirmed project mint must be configured before observation is enabled.' } };
      emit();
      return getState();
    }
    if (!Array.isArray(accounts) || !accounts.length || accounts.length > MAX_ACCOUNTS
      || accounts.some(account => !validateInput('snapshot', account).valid)) {
      throw new Error(`Choose between one and ${MAX_ACCOUNTS} valid Solana account addresses.`);
    }
    const unique = [...new Set(accounts.map(account => validateInput('snapshot', account).value))];
    const sameScope = state.accounts.join(',') === unique.join(',');
    stop();
    if (!sameScope) { cursors.clear(); pending.clear(); processed.clear(); events.clear(); }
    state = { ...state, accounts: unique, status: target?.hidden ? 'paused' : 'observing',
      startedAt: sameScope && state.startedAt ? state.startedAt : now(), error: null,
      gaps: sameScope ? state.gaps : [] };
    active = true;
    emit();
    return poll();
  }

  function onVisibility() {
    if (!active) return;
    if (target?.hidden) {
      ++generation;
      controller?.abort();
      controller = null;
      inFlight = null;
      if (timer !== null) clearTimer(timer);
      timer = null;
      state = { ...state, status: 'paused' };
      emit();
    } else {
      state = { ...state, status: 'observing' };
      emit();
      void poll();
    }
  }
  target?.addEventListener?.('visibilitychange', onVisibility);

  return Object.freeze({ getState, start, stop, poll,
    subscribe(listener) { subscribers.add(listener); listener(getState()); return () => subscribers.delete(listener); },
    destroy() { stop(); destroyed = true; target?.removeEventListener?.('visibilitychange', onVisibility); subscribers.clear(); },
  });
}
