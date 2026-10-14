import { formatAmount, integerOrNull } from './precision.js';
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM, explorerUrl, validateInput } from './validation.js';
import { rpcWithEvidence, RpcError } from './transport.js';
import { check, evidenceRef } from './transaction.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encodeBase58(bytes) {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) + BigInt(byte);
  let value = '';
  while (n) { value = ALPHABET[Number(n % 58n)] + value; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; value = '1' + value; }
  return value;
}
function decodeBase64(data) {
  if (!Array.isArray(data) || data[1] !== 'base64' || typeof data[0] !== 'string' || data[0].length > 1024 * 1024) return null;
  try { return Uint8Array.from(atob(data[0]), character => character.charCodeAt(0)); } catch { return null; }
}
const u32 = (bytes, offset) => bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536 + bytes[offset + 3] * 16777216;
function binaryAuthority(bytes, offset) {
  const option = u32(bytes, offset);
  if (option === 0) return null;
  if (option === 1) return encodeBase58(bytes.slice(offset + 4, offset + 36));
  return undefined;
}

export function readBinaryMint(account) {
  const bytes = decodeBase64(account?.data);
  if (!bytes) return { valid: false, reason: 'Binary Mint data was not available.' };
  const token2022 = account.owner === TOKEN_2022_PROGRAM;
  if (!(bytes.length === 82 || token2022 && bytes.length >= 166 && bytes.length !== 355 && bytes[165] === 1 && bytes.slice(82, 165).every(byte => byte === 0))) return { valid: false, reason: 'The binary account layout does not identify a Mint.' };
  if (![0, 1].includes(bytes[45])) return { valid: false, reason: 'The Mint initialization flag is invalid.' };
  let supply = 0n;
  for (let index = 43; index >= 36; index--) supply = (supply << 8n) + BigInt(bytes[index]);
  const info = { supply: supply.toString(), decimals: bytes[44], isInitialized: bytes[45] === 1 };
  const mintAuthority = binaryAuthority(bytes, 0), freezeAuthority = binaryAuthority(bytes, 46);
  if (mintAuthority !== undefined) info.mintAuthority = mintAuthority;
  if (freezeAuthority !== undefined) info.freezeAuthority = freezeAuthority;
  const extensionTypes = [];
  let extensionComplete = true, reason = null;
  if (token2022 && bytes.length > 82) {
    let offset = 166;
    while (offset < bytes.length) {
      if (bytes.length - offset < 2) { extensionComplete = bytes.slice(offset).every(byte => byte === 0); break; }
      const typeId = bytes[offset] + bytes[offset + 1] * 256;
      if (typeId === 0) break;
      if (offset + 4 > bytes.length) { extensionComplete = false; reason = 'An extension header was truncated.'; break; }
      const byteLength = bytes[offset + 2] + bytes[offset + 3] * 256;
      if (offset + 4 + byteLength > bytes.length) { extensionComplete = false; reason = 'An extension payload was truncated.'; break; }
      extensionTypes.push({ typeId, byteLength, offset, label: `Extension type ${typeId}` });
      if (extensionTypes.length > 128) { extensionComplete = false; reason = 'The extension count exceeds this inspector’s bounded scope.'; break; }
      offset += 4 + byteLength;
    }
  }
  return { valid: true, info, extensionTypes, extensionComplete, reason, byteLength: bytes.length };
}

function authority(info, key) {
  if (Object.hasOwn(info, key) && info[key] === null) return { state: 'revoked', address: null };
  if (typeof info[key] === 'string' && validateInput('address', info[key]).valid) return { state: 'present', address: info[key] };
  return { state: 'unknown', address: null };
}
const plainString = value => typeof value === 'string' ? value.slice(0, 250) : null;

export function normalizeToken(mint, network, read, binaryRead = null, binaryFailure = null) {
  if (!read.result || typeof read.result !== 'object' || !Object.hasOwn(read.result, 'value')) throw new RpcError('INVALID_RESPONSE', 'The RPC did not return a usable account response.', true);
  const account = read.result.value, programId = account?.owner || null;
  const recognizedProgram = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(programId);
  const parsed = account?.data?.parsed;
  const binaryAccount = binaryRead?.result?.value || (Array.isArray(account?.data) ? account : null);
  const binary = binaryAccount && binaryAccount.owner === programId ? readBinaryMint(binaryAccount) : null;
  const parsedMint = parsed?.type === 'mint' && parsed.info && typeof parsed.info === 'object';
  const mintConfirmed = recognizedProgram && account.executable === false && (parsedMint || binary?.valid === true);
  const info = parsedMint ? parsed.info : binary?.valid ? binary.info : {};
  const supply = integerOrNull(info.supply), decimals = Number.isInteger(info.decimals) && info.decimals >= 0 && info.decimals <= 255 ? info.decimals : null;
  const mintAuthority = mintConfirmed ? authority(info, 'mintAuthority') : { state: 'unknown', address: null };
  const freezeAuthority = mintConfirmed ? authority(info, 'freezeAuthority') : { state: 'unknown', address: null };
  const parsedExtensions = Array.isArray(info.extensions) ? info.extensions : [];
  const extensions = parsedExtensions.map((extension, index) => ({ index, name: plainString(extension?.extension) || `Unparsed extension ${index + 1}`, state: extension?.state ?? null, source: 'RPC jsonParsed', recognized: typeof extension?.extension === 'string' && extension.extension !== 'uninitialized' }));
  const metadataEntry = extensions.find(extension => extension.name.toLowerCase().replace(/[^a-z]/g, '') === 'tokenmetadata');
  const metadata = metadataEntry?.state && typeof metadataEntry.state === 'object' ? { name: plainString(metadataEntry.state.name), symbol: plainString(metadataEntry.state.symbol), uri: plainString(metadataEntry.state.uri), source: 'Token-2022 on-account metadata', fetchedExternal: false } : { name: null, symbol: null, uri: null, source: null, fetchedExternal: false };
  const refs = [evidenceRef('mint-account', 'getAccountInfo', 'result.value', read)];
  if (binaryRead) refs.push(evidenceRef('mint-binary', 'getAccountInfo', 'result.value.data[0]', binaryRead));
  const token2022 = programId === TOKEN_2022_PROGRAM;
  const binaryTypes = binary?.valid ? binary.extensionTypes : null;
  const extensionCoverage = !token2022 || binary?.valid && binary.extensionComplete && binary.extensionTypes.length === extensions.length && extensions.every(extension => extension.recognized);
  const coreConsistent = !binary?.valid || !parsedMint || binary.info.supply === supply && binary.info.decimals === decimals && binary.info.isInitialized === info.isInitialized && JSON.stringify(authority(binary.info, 'mintAuthority')) === JSON.stringify(mintAuthority) && JSON.stringify(authority(binary.info, 'freezeAuthority')) === JSON.stringify(freezeAuthority);
  const checks = [
    check('mint-type', 'Account is a Mint', account === null ? 'unknown' : mintConfirmed ? 'pass' : 'fail', account === null ? 'The data source did not return this account.' : mintConfirmed ? 'The account belongs to a recognized Token Program and identifies a Mint.' : 'This account does not identify a supported Mint. Wallets, Token accounts, and executable programs are not accepted as Mints.', 'getAccountInfo.result.value.owner; data.parsed.type or binary Mint layout', account === null ? 'Account absence at this read does not prove historical inexistence.' : undefined),
    check('mint-initialized', 'Mint is initialized', mintConfirmed && typeof info.isInitialized === 'boolean' ? info.isInitialized ? 'pass' : 'fail' : 'unknown', mintConfirmed && typeof info.isInitialized === 'boolean' ? info.isInitialized ? 'The Mint initialization flag is set.' : 'The Mint is not initialized.' : 'The initialization flag was not available.', 'data.parsed.info.isInitialized or binary byte 45'),
    check('mint-supply', 'Exact supply and decimals', mintConfirmed && supply !== null && decimals !== null ? 'pass' : 'unknown', mintConfirmed && supply !== null && decimals !== null ? 'Supply is preserved as an integer and formatted with the Mint decimals.' : 'Exact supply or decimals could not be read.', 'data.parsed.info.supply; data.parsed.info.decimals', 'Supply does not establish circulating supply, price, liquidity, or market capitalization.'),
    check('mint-authority', 'Mint authority revoked', mintAuthority.state === 'revoked' ? 'pass' : mintAuthority.state === 'present' ? 'fail' : 'unknown', mintAuthority.state === 'present' ? `Mint authority remains present: ${mintAuthority.address}.` : mintAuthority.state === 'revoked' ? 'The Mint authority field is explicitly null.' : 'The Mint authority field could not be read.', 'data.parsed.info.mintAuthority or binary Mint authority option', 'This is one defined control check; it is not a safety audit.'),
    check('freeze-authority', 'Freeze authority revoked', freezeAuthority.state === 'revoked' ? 'pass' : freezeAuthority.state === 'present' ? 'fail' : 'unknown', freezeAuthority.state === 'present' ? `Freeze authority remains present: ${freezeAuthority.address}.` : freezeAuthority.state === 'revoked' ? 'The Freeze authority field is explicitly null.' : 'The Freeze authority field could not be read.', 'data.parsed.info.freezeAuthority or binary Freeze authority option', 'Missing authority data is never treated as revoked.'),
    check('mint-core-consistency', 'Mint read consistency', coreConsistent && (!token2022 || binary?.valid) ? 'pass' : 'unknown', coreConsistent ? token2022 ? 'Parsed and binary Mint control fields agree where both were read.' : 'Mint control fields were read from this account response.' : 'Parsed and binary control fields differed between observations.', 'Parsed Mint fields compared with binary Mint base fields', 'Separate RPC reads are not atomic; their context slots are retained.'),
    check('token-extensions', 'Token extension reading scope', extensionCoverage && mintConfirmed ? 'pass' : 'unknown', !token2022 ? 'The original Token Program has no Token-2022 extension scope.' : binaryTypes ? `${binaryTypes.length} binary extension entries and ${extensions.length} RPC-parsed entries were observed.` : 'Binary extension inventory could not be read.', 'data.parsed.info.extensions; Token-2022 TLV inventory', token2022 ? `${binaryFailure || binary?.reason || ''} Extension names and states come from the RPC parser. Unparsed IDs remain visible; this inspector does not verify transfer hooks, fee policy, confidential balances, metadata authenticity, or all extension semantics.`.trim() : 'Only Mint identity, supply, and the listed authority checks are covered.'),
    check('token-metadata', 'On-account metadata availability', metadata.name || metadata.symbol ? 'pass' : 'unknown', metadata.name || metadata.symbol ? 'Name and symbol were read from the Mint’s on-account Token-2022 metadata.' : 'No name or symbol was returned in this Mint response.', 'Token-2022 tokenMetadata extension', 'External metadata URLs are not fetched. All metadata is untrusted text.'),
  ];
  return {
    kind: 'token', summary: { network, input: mint, mint, explorerUrl: explorerUrl('token', mint, network), taskStatus: account === null ? 'incomplete' : 'completed', isMint: mintConfirmed, programId, programName: programId === TOKEN_PROGRAM ? 'Token Program' : token2022 ? 'Token-2022 / Token Extension Program' : 'Unrecognized owner', supplyRaw: mintConfirmed ? supply : null, supply: mintConfirmed && supply !== null && decimals !== null ? formatAmount(supply, decimals) : null, decimals: mintConfirmed ? decimals : null, mintAuthority, freezeAuthority, initialized: mintConfirmed && typeof info.isInitialized === 'boolean' ? info.isInitialized : null, extensions, extensionTypes: binaryTypes || [], extensionCoverage: Boolean(extensionCoverage && mintConfirmed), metadata, name: metadata.name, symbol: metadata.symbol, slot: integerOrNull(read.result.context?.slot), contextSlots: { parsed: integerOrNull(read.result.context?.slot), binary: integerOrNull(binaryRead?.result?.context?.slot) }, readingScope: 'Mint identity, base fields, authority states, and RPC-parsed Token-2022 extensions. No security rating or market data.' },
    checks, raw: { account: read.result, binaryAccount: binaryRead?.result || null, binaryReadError: binaryFailure, precision: read.precision }, evidenceRefs: refs, observedAt: read.observedAt, dataSource: read.dataSource, cached: refs.some(ref => ref.cached), cacheAgeMs: Math.max(...refs.map(ref => ref.cacheAgeMs)),
  };
}

/**
 * @param {string} mint
 * @param {string} network
 * @param {{signal?: AbortSignal}} [options]
 */
export async function inspectToken(mint, network, options = {}) {
  const validation = validateInput('token', mint);
  if (!validation.valid) throw new RpcError('INVALID_INPUT', validation.error);
  const read = await rpcWithEvidence('getAccountInfo', [validation.value, { encoding: 'jsonParsed', commitment: 'confirmed' }], network, options);
  let binaryRead = null, binaryFailure = null;
  if (read.result?.value?.owner === TOKEN_2022_PROGRAM && !Array.isArray(read.result.value.data)) {
    const slot = read.result.context?.slot;
    try { binaryRead = await rpcWithEvidence('getAccountInfo', [validation.value, { encoding: 'base64', commitment: 'confirmed', ...(Number.isSafeInteger(slot) ? { minContextSlot: slot } : {}) }], network, options); }
    catch (error) { if (error.name === 'AbortError') throw error; binaryFailure = error.message; }
  }
  return normalizeToken(validation.value, network, read, binaryRead, binaryFailure);
}
