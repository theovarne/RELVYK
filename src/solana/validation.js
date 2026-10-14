export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const NETWORKS = Object.freeze(['mainnet-beta', 'devnet', 'testnet']);
export const PUBLIC_RPC = Object.freeze({
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
});
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function decodeBase58(value) {
  if (typeof value !== 'string' || value.length > 128 || !value || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) throw new TypeError('Invalid base58 value.');
  let n = 0n;
  for (const char of value) n = n * 58n + BigInt(ALPHABET.indexOf(char));
  const bytes = [];
  while (n) { bytes.push(Number(n & 255n)); n >>= 8n; }
  for (const char of value) { if (char !== '1') break; bytes.push(0); }
  return new Uint8Array(bytes.reverse());
}

export function validateInput(type, input) {
  const value = typeof input === 'string' ? input.trim() : '';
  const signature = type === 'transaction';
  if (!['transaction', 'token', 'mint', 'snapshot', 'address', 'account'].includes(type)) return { valid: false, value, error: 'Choose a supported inspection type.' };
  try {
    const bytes = decodeBase58(value);
    if (bytes.length !== (signature ? 64 : 32)) throw new TypeError('Wrong decoded length.');
    return { valid: true, value, error: null };
  } catch {
    return { valid: false, value, error: signature ? 'Enter a base58 Solana transaction signature (64 decoded bytes).' : 'Enter a base58 Solana account or Mint address (32 decoded bytes).' };
  }
}

export function normalizeNetwork(network) {
  if (!NETWORKS.includes(network)) throw new TypeError('Choose Mainnet Beta, Devnet, or Testnet.');
  return network;
}

export function explorerUrl(type, input, network) {
  normalizeNetwork(network);
  return `https://explorer.solana.com/${type === 'transaction' ? 'tx' : 'address'}/${encodeURIComponent(input)}${network === 'mainnet-beta' ? '' : '?cluster=' + network}`;
}

function options(value, allowed) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('Unsupported RPC options.');
  if (value.commitment !== undefined && !['confirmed', 'finalized'].includes(value.commitment)) throw new TypeError('Only confirmed or finalized reads are supported.');
  if (value.minContextSlot !== undefined && (!Number.isSafeInteger(value.minContextSlot) || value.minContextSlot < 0)) throw new TypeError('Invalid minimum context slot.');
  return value;
}

export function validateRpcRequest(method, params, network) {
  normalizeNetwork(network);
  if (!Array.isArray(params) || params.length > 3) throw new TypeError('RPC params must be a bounded array.');
  const address = (value, type = 'address') => { if (!validateInput(type, value).valid) throw new TypeError('Invalid RPC account or signature.'); };
  if (method === 'getTransaction') {
    if (params.length !== 2) throw new TypeError('Transaction options are required.');
    address(params[0], 'transaction');
    const config = options(params[1], ['commitment', 'encoding', 'maxSupportedTransactionVersion']);
    if (config.encoding !== 'jsonParsed' || ![0, 1].includes(config.maxSupportedTransactionVersion)) throw new TypeError('Use jsonParsed encoding with a supported numeric version ceiling of 0 or 1.');
  } else if (method === 'getSignatureStatuses') {
    if (params.length !== 2 || !Array.isArray(params[0]) || params[0].length < 1 || params[0].length > 20) throw new TypeError('Request between 1 and 20 signatures.');
    params[0].forEach(value => address(value, 'transaction'));
    const config = options(params[1], ['searchTransactionHistory']);
    if (typeof config.searchTransactionHistory !== 'boolean') throw new TypeError('Explicit history search setting is required.');
  } else if (['getAccountInfo', 'getBalance', 'getTokenSupply'].includes(method)) {
    if (params.length !== 2) throw new TypeError('Read options are required.');
    address(params[0]);
    const config = options(params[1], method === 'getAccountInfo' ? ['commitment', 'encoding', 'minContextSlot'] : ['commitment', 'minContextSlot']);
    if (method === 'getAccountInfo' && !['jsonParsed', 'base64'].includes(config.encoding)) throw new TypeError('Unsupported account encoding.');
  } else if (method === 'getTokenAccountsByOwner') {
    if (params.length !== 3) throw new TypeError('Owner, program, and read options are required.');
    address(params[0]);
    const filter = options(params[1], ['programId']);
    if (![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(filter.programId)) throw new TypeError('Only the two Solana Token Programs are supported.');
    const config = options(params[2], ['commitment', 'encoding', 'minContextSlot']);
    if (config.encoding !== 'jsonParsed') throw new TypeError('Token accounts require jsonParsed encoding.');
  } else if (method === 'getSignaturesForAddress') {
    if (params.length !== 2) throw new TypeError('Address and bounded options are required.');
    address(params[0]);
    const config = options(params[1], ['commitment', 'limit', 'before', 'until', 'minContextSlot']);
    if (!Number.isInteger(config.limit) || config.limit < 1 || config.limit > 20) throw new TypeError('History limit must be between 1 and 20.');
    if (config.before) address(config.before, 'transaction');
    if (config.until) address(config.until, 'transaction');
  } else if (method === 'getSlot') {
    if (params.length !== 1) throw new TypeError('Slot options are required.');
    options(params[0], ['commitment', 'minContextSlot']);
  } else throw new TypeError('This method is outside the read-only RPC allowlist.');
  return { method, params, network };
}
