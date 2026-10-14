import { validateInput } from './solana/validation.js';

/**
 * Read-only identity connection using Wallet Standard's browser handshake.
 * No signing, authentication, approval, or transaction API is exposed here.
 * References: https://github.com/wallet-standard/wallet-standard
 */
const SOLANA_CHAINS = new Set(['solana:mainnet', 'solana:devnet', 'solana:testnet']);
const NETWORK_CHAINS = Object.freeze({ 'mainnet-beta': 'solana:mainnet', devnet: 'solana:devnet', testnet: 'solana:testnet' });

function feature(wallet, name, method) {
  const value = wallet?.features?.[name];
  return value?.version === '1.0.0' && typeof value[method] === 'function' ? value : null;
}

function isSolanaWallet(wallet) {
  return wallet && typeof wallet.name === 'string' && Array.isArray(wallet.chains)
    && wallet.chains.some(chain => SOLANA_CHAINS.has(chain))
    && feature(wallet, 'standard:connect', 'connect') && feature(wallet, 'standard:events', 'on');
}

function accountsForSolana(accounts) {
  if (!Array.isArray(accounts)) return [];
  return accounts.filter(account => typeof account?.address === 'string'
    && validateInput('address', account.address).valid
    && Array.isArray(account.chains) && account.chains.some(chain => SOLANA_CHAINS.has(chain)))
    .map(account => ({ address: account.address, chains: [...account.chains].filter(chain => SOLANA_CHAINS.has(chain)),
      features: Array.isArray(account.features) ? account.features.filter(name => typeof name === 'string') : [],
      label: typeof account.label === 'string' ? account.label : null }));
}

function safeIcon(icon) {
  return typeof icon === 'string' && /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(icon)
    && icon.length <= 500_000 ? icon : null;
}

function connectionError(error) {
  if (error?.code === 4001 || error?.code === 'USER_REJECTED' || /reject|denied|declined|cancel/i.test(String(error?.message))) {
    return { code: 'USER_REJECTED', message: 'Connection was declined. Read-only inspection is still available.' };
  }
  return { code: 'CONNECTION_FAILED', message: 'The wallet did not complete the connection. Try again or choose another detected wallet.' };
}

export function createWalletService({ target = globalThis.window, network = 'mainnet-beta' } = {}) {
  if (!NETWORK_CHAINS[network]) throw new Error('Unsupported Solana network.');
  const wallets = new Map();
  const walletIds = new WeakMap();
  const subscribers = new Set();
  let sequence = 0;
  let operation = 0;
  let destroyed = false;
  let state = { status: 'disconnected', walletId: null, walletName: null, address: null,
    accounts: [], network, supportsNetwork: false, error: null };

  function getWallets() {
    return [...wallets.entries()].filter(([, entry]) => isSolanaWallet(entry.wallet)).map(([id, { wallet }]) => ({
      id, name: wallet.name, icon: safeIcon(wallet.icon), chains: wallet.chains.filter(chain => SOLANA_CHAINS.has(chain)),
      canDisconnect: Boolean(feature(wallet, 'standard:disconnect', 'disconnect')),
    }));
  }

  function getState() {
    return { ...state, accounts: state.accounts.map(account => ({ ...account, chains: [...account.chains], features: [...account.features] })),
      error: state.error ? { ...state.error } : null, wallets: getWallets() };
  }

  function emit() {
    if (destroyed) return;
    const snapshot = getState();
    for (const listener of subscribers) {
      try { listener(snapshot); } catch { /* Subscriber failures must not break a wallet event. */ }
    }
  }

  function clearIdentity(status = 'disconnected', error = null) {
    state = { ...state, status, walletId: null, walletName: null, address: null,
      accounts: [], supportsNetwork: false, error };
  }

  function setAccounts(id, accounts) {
    const entry = wallets.get(id);
    const available = accountsForSolana(accounts);
    if (!entry || !isSolanaWallet(entry.wallet) || !available.length) {
      clearIdentity();
      emit();
      return;
    }
    const current = available.find(account => account.address === state.address) || available[0];
    state = { ...state, status: 'connected', walletId: id, walletName: entry.wallet.name,
      address: current.address, accounts: available,
      supportsNetwork: current.chains.includes(NETWORK_CHAINS[state.network]), error: null };
    emit();
  }

  function register(...candidates) {
    if (destroyed) return () => {};
    const added = [];
    for (const wallet of candidates) {
      if (!isSolanaWallet(wallet) || walletIds.has(wallet)) continue;
      const id = `wallet-${++sequence}`;
      let off;
      try {
        off = feature(wallet, 'standard:events', 'on').on('change', change => {
          if (destroyed || !wallets.has(id)) return;
          if (state.walletId === id) {
            if (!isSolanaWallet(wallet)) {
              ++operation;
              clearIdentity('disconnected', { code: 'UNSUPPORTED_WALLET', message: 'This wallet no longer exposes the required Solana connection features.' });
            } else if (Array.isArray(change?.accounts)) {
              setAccounts(id, change.accounts);
              return;
            } else {
              setAccounts(id, wallet.accounts);
              return;
            }
          }
          emit();
        });
      } catch { continue; }
      walletIds.set(wallet, id);
      wallets.set(id, { wallet, off: typeof off === 'function' ? off : () => {} });
      added.push(id);
    }
    if (added.length) emit();
    return () => {
      for (const id of added) {
        const entry = wallets.get(id);
        if (!entry) continue;
        try { entry.off(); } catch { /* Continue disconnect cleanup. */ }
        wallets.delete(id);
        walletIds.delete(entry.wallet);
        if (state.walletId === id) { ++operation; clearIdentity(); }
      }
      emit();
    };
  }

  const registry = Object.freeze({ register });
  const onRegister = event => {
    if (typeof event?.detail !== 'function') return;
    try { event.detail(registry); } catch { /* Ignore malformed providers; do not expose extension errors. */ }
  };
  target?.addEventListener?.('wallet-standard:register-wallet', onRegister);
  if (target?.dispatchEvent) {
    const EventClass = target.Event || globalThis.Event;
    if (EventClass) {
      // Standard wallets expect an Event with an immutable `detail` registry.
      class AppReadyEvent extends EventClass {
        constructor() { super('wallet-standard:app-ready'); }
        get detail() { return registry; }
      }
      target.dispatchEvent(new AppReadyEvent());
    }
  }

  async function disconnect() {
    const entry = wallets.get(state.walletId);
    const id = ++operation;
    // Clear identity immediately, including while a previous connect promise is pending.
    clearIdentity(entry ? 'disconnecting' : 'disconnected');
    emit();
    try { await feature(entry?.wallet, 'standard:disconnect', 'disconnect')?.disconnect(); }
    catch {
      if (id === operation && !destroyed) {
        clearIdentity('disconnected', { code: 'DISCONNECT_FAILED', message: 'Identity was cleared in this page. The wallet could not confirm its own disconnect.' });
        emit();
      }
      return getState();
    }
    if (id === operation && !destroyed) { clearIdentity(); emit(); }
    return getState();
  }

  async function connect(walletId) {
    if (destroyed) throw new Error('Wallet service has been disposed.');
    const entry = wallets.get(walletId);
    if (!entry || !isSolanaWallet(entry.wallet)) {
      state = { ...state, error: { code: 'WALLET_UNAVAILABLE', message: 'No compatible wallet was detected. Install or unlock a Solana wallet, then retry.' } };
      emit();
      return getState();
    }
    if (state.walletId === walletId && state.status === 'connected') return getState();
    const previous = wallets.get(state.walletId);
    const id = ++operation;
    clearIdentity('connecting');
    state = { ...state, walletId, walletName: entry.wallet.name };
    emit();
    try {
      // Previous-provider cleanup may fail; the old page identity is already cleared.
      try { await feature(previous?.wallet, 'standard:disconnect', 'disconnect')?.disconnect(); } catch { /* Allow choosing another wallet. */ }
      if (id !== operation || destroyed) return getState();
      const connected = await feature(entry.wallet, 'standard:connect', 'connect').connect();
      if (id !== operation || destroyed || !wallets.has(walletId)) return getState();
      const accounts = accountsForSolana(connected?.accounts);
      if (!accounts.length) {
        clearIdentity('disconnected', { code: 'NO_SOLANA_ACCOUNT', message: 'The wallet did not provide an authorized Solana account. Read-only inspection remains available.' });
        emit();
      } else {
        setAccounts(walletId, accounts);
      }
    } catch (error) {
      if (id === operation && !destroyed) { clearIdentity('disconnected', connectionError(error)); emit(); }
    }
    return getState();
  }

  return Object.freeze({
    getWallets, getState, connect, disconnect,
    subscribe(listener) {
      subscribers.add(listener);
      listener(getState());
      return () => subscribers.delete(listener);
    },
    setNetwork(nextNetwork) {
      if (!NETWORK_CHAINS[nextNetwork]) throw new Error('Unsupported Solana network.');
      state = { ...state, network: nextNetwork,
        supportsNetwork: state.accounts.some(account => account.address === state.address && account.chains.includes(NETWORK_CHAINS[nextNetwork])) };
      emit();
    },
    destroy() {
      ++operation;
      destroyed = true;
      target?.removeEventListener?.('wallet-standard:register-wallet', onRegister);
      for (const entry of wallets.values()) { try { entry.off(); } catch { /* Continue cleanup. */ } }
      wallets.clear();
      subscribers.clear();
      clearIdentity();
    },
  });
}
