export const display = value => value === null || value === undefined || value === '' ? 'Not returned' : String(value);
export const shortAddress = value => typeof value === 'string' && value.length > 22 ? `${value.slice(0, 9)}…${value.slice(-8)}` : display(value);
export const safeJSON = value => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2);
export function safeExplorerURL(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'explorer.solana.com' || url.username || url.password || url.port || url.hash) return null;
    if (!/^\/(tx|address)\/[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(url.pathname)) return null;
    if ([...url.searchParams.keys()].some(key => key !== 'cluster') || url.searchParams.getAll('cluster').length > 1) return null;
    const cluster = url.searchParams.get('cluster');
    if (cluster && !['devnet', 'testnet', 'mainnet-beta'].includes(cluster)) return null;
    return url.href;
  } catch { return null; }
}
export function utc(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC` : 'Not returned';
}
/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} [className]
 * @param {unknown} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
export function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text === '' ? '' : display(text);
  return item;
}
export function action(text, callback, className = 'quiet-button') {
  const item = node('button', className, text); item.type = 'button';
  item.addEventListener('click', () => Promise.resolve().then(callback).catch(error => toast(error.message || 'The action could not complete. Try again.')));
  return item;
}
let toastTimer;
export function toast(message) {
  const item = document.getElementById('toast');
  if (!item) return;
  item.textContent = String(message); item.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { item.hidden = true; }, 3600);
}
export async function copyText(value) {
  try {
    await navigator.clipboard.writeText(String(value)); toast('Copied to clipboard.'); return true;
  } catch {
    toast('Clipboard access was not available. Select and copy the text directly.'); return false;
  }
}
export function exportJSON(value, name = 'relvyk-evidence') {
  const blob = new Blob([safeJSON(value)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `${String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)}.json`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
