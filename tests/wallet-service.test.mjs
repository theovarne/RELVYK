import test from 'node:test';
import assert from 'node:assert/strict';
import { createWalletService } from '../src/wallet-service.js';

// These are mock provider tests. They never access a real wallet or request a signature.
const ADDRESS = '11111111111111111111111111111111';
const OTHER_ADDRESS = 'So11111111111111111111111111111111111111112';
const account = address => ({ address, publicKey: new Uint8Array(32), chains: ['solana:mainnet', 'solana:devnet'],
  features: ['solana:signMessage'], label: 'Mock account' });
class MockWindow extends EventTarget { Event = Event; }
function registerLater(target, wallet) {
  const event = new Event('wallet-standard:register-wallet');
  Object.defineProperty(event, 'detail', { value: api => api.register(wallet) });
  target.dispatchEvent(event);
}
function mockWallet(name = 'Mock Solana Wallet', overrides = {}) {
  let accounts = [];
  let change;
  const calls = [];
  const wallet = {
    version: '1.0.0', name, icon: 'data:image/png;base64,AA==', chains: ['solana:mainnet', 'solana:devnet'],
    get accounts() { return accounts; },
    features: {
      'standard:connect': { version: '1.0.0', async connect() { calls.push('connect'); accounts = [account(ADDRESS)]; return { accounts }; } },
      'standard:disconnect': { version: '1.0.0', async disconnect() { calls.push('disconnect'); accounts = []; change?.({ accounts }); } },
      'standard:events': { version: '1.0.0', on(event, listener) { assert.equal(event, 'change'); change = listener; return () => { calls.push('unsubscribe'); change = null; }; } },
      'solana:signMessage': { version: '1.0.0', async signMessage() { calls.push('SIGNING MUST NOT RUN'); throw new Error('Never call signing'); } },
    }, ...overrides,
  };
  return { wallet, calls, change(next) { accounts = next; change?.({ accounts }); } };
}

test('mock: no extension yields empty real-detection list and remains disconnected', async () => {
  const service = createWalletService({ target: new MockWindow() });
  assert.deepEqual(service.getWallets(), []);
  const state = await service.connect('missing');
  assert.equal(state.status, 'disconnected');
  assert.equal(state.error.code, 'WALLET_UNAVAILABLE');
  service.destroy();
});

test('mock: app-ready handshake detects preloaded wallet without connecting', () => {
  const target = new MockWindow();
  const mock = mockWallet();
  target.addEventListener('wallet-standard:app-ready', event => event.detail.register(mock.wallet));
  const service = createWalletService({ target });
  assert.equal(service.getWallets()[0].name, mock.wallet.name);
  assert.deepEqual(mock.calls, []);
  assert.equal(service.getState().address, null);
  service.destroy();
});

test('mock: late discovery is deduplicated and multiple wallets have distinct IDs', () => {
  const target = new MockWindow();
  const service = createWalletService({ target });
  const a = mockWallet('Wallet A');
  const b = mockWallet('Wallet B');
  registerLater(target, a.wallet);
  registerLater(target, a.wallet);
  registerLater(target, b.wallet);
  assert.equal(service.getWallets().length, 2);
  assert.notEqual(service.getWallets()[0].id, service.getWallets()[1].id);
  service.destroy();
});

test('mock: EVM and unsupported connection versions are excluded', () => {
  const target = new MockWindow();
  const service = createWalletService({ target });
  const evm = mockWallet('EVM', { chains: ['eip155:1'] });
  const future = mockWallet('Future');
  future.wallet.features['standard:connect'].version = '2.0.0';
  registerLater(target, evm.wallet);
  registerLater(target, future.wallet);
  assert.deepEqual(service.getWallets(), []);
  service.destroy();
});

test('mock: connection requests identity only and account changes replace identity', async () => {
  const target = new MockWindow();
  const service = createWalletService({ target });
  const mock = mockWallet();
  registerLater(target, mock.wallet);
  await service.connect(service.getWallets()[0].id);
  assert.equal(service.getState().address, ADDRESS);
  mock.change([account(OTHER_ADDRESS)]);
  assert.equal(service.getState().address, OTHER_ADDRESS);
  assert.deepEqual(mock.calls, ['connect']);
  assert.equal('signMessage' in service, false);
  assert.equal('signTransaction' in service, false);
  assert.equal('authenticate' in service, false);
  await service.disconnect();
  assert.equal(service.getState().address, null);
  assert.equal(service.getState().walletId, null);
  service.destroy();
});

test('mock: user rejection preserves public read-only availability', async () => {
  const target = new MockWindow();
  const service = createWalletService({ target });
  const mock = mockWallet();
  mock.wallet.features['standard:connect'].connect = async () => { throw { code: 4001, message: 'User rejected' }; };
  registerLater(target, mock.wallet);
  const state = await service.connect(service.getWallets()[0].id);
  assert.equal(state.status, 'disconnected');
  assert.equal(state.address, null);
  assert.equal(state.error.code, 'USER_REJECTED');
  service.destroy();
});

test('mock: missing disconnect feature clears page identity locally', async () => {
  const target = new MockWindow();
  const service = createWalletService({ target });
  const mock = mockWallet();
  delete mock.wallet.features['standard:disconnect'];
  registerLater(target, mock.wallet);
  assert.equal(service.getWallets()[0].canDisconnect, false);
  await service.connect(service.getWallets()[0].id);
  await service.disconnect();
  assert.equal(service.getState().status, 'disconnected');
  assert.deepEqual(mock.calls, ['connect']);
  service.destroy();
});

test('mock: late connect resolution cannot restore identity after disconnect', async () => {
  const target = new MockWindow();
  const service = createWalletService({ target });
  const mock = mockWallet();
  let resolve;
  mock.wallet.features['standard:connect'].connect = () => new Promise(done => { resolve = done; });
  registerLater(target, mock.wallet);
  const connecting = service.connect(service.getWallets()[0].id);
  await Promise.resolve();
  await service.disconnect();
  resolve({ accounts: [account(ADDRESS)] });
  await connecting;
  assert.equal(service.getState().address, null);
  service.destroy();
});

test('mock: non-Solana account cannot become a Solana identity', async () => {
  const target = new MockWindow();
  const service = createWalletService({ target });
  const mock = mockWallet();
  mock.wallet.features['standard:connect'].connect = async () => ({ accounts: [{ ...account(ADDRESS), chains: ['eip155:1'] }] });
  registerLater(target, mock.wallet);
  const state = await service.connect(service.getWallets()[0].id);
  assert.equal(state.error.code, 'NO_SOLANA_ACCOUNT');
  assert.equal(state.address, null);
  service.destroy();
});

test('mock: selecting another wallet disconnects previous identity and network is explicit', async () => {
  const target = new MockWindow();
  const service = createWalletService({ target });
  const a = mockWallet('A');
  const b = mockWallet('B');
  registerLater(target, a.wallet);
  registerLater(target, b.wallet);
  const [aId, bId] = service.getWallets().map(wallet => wallet.id);
  await service.connect(aId);
  await service.connect(bId);
  assert.equal(service.getState().walletName, 'B');
  assert.deepEqual(a.calls, ['connect', 'disconnect']);
  service.setNetwork('testnet');
  assert.equal(service.getState().network, 'testnet');
  assert.equal(service.getState().supportsNetwork, false);
  service.destroy();
});

test('mock: unregister and disconnect failure always clear page identity', async () => {
  const target = new MockWindow();
  const mock = mockWallet();
  let unregister;
  target.addEventListener('wallet-standard:app-ready', event => { unregister = event.detail.register(mock.wallet); });
  const service = createWalletService({ target });
  await service.connect(service.getWallets()[0].id);
  unregister();
  assert.equal(service.getState().address, null);
  assert.equal(service.getWallets().length, 0);
  registerLater(target, mock.wallet);
  await service.connect(service.getWallets()[0].id);
  mock.wallet.features['standard:disconnect'].disconnect = async () => { throw new Error('Mock RPC? sensitive stack not disclosed'); };
  await service.disconnect();
  assert.equal(service.getState().address, null);
  assert.equal(service.getState().error.code, 'DISCONNECT_FAILED');
  service.destroy();
});
