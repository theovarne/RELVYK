/**
 * Mounts the configured public project address. This component never queries the
 * chain, discovers wallets, or supplies an example address.
 * @param {{address?: string | null, root?: ParentNode | null,
 * clipboard?: Pick<Clipboard, 'writeText'> | null,
 * setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout}} [options]
 */
export function mountProjectCA({ address = null, root = globalThis.document,
  clipboard = globalThis.navigator?.clipboard, setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout } = {}) {
  const code = root?.querySelector('#project-ca-address');
  const button = /** @type {HTMLButtonElement | null} */ (root?.querySelector('#project-ca-copy'));
  const status = root?.querySelector('#project-ca-status');
  const label = button?.querySelector('[data-copy-label]');
  const value = typeof address === 'string' ? address.trim() : '';
  let destroyed = false, copying = false, timer = null;

  if (!code || !button || !status || !label) return { mounted: false, destroy() {} };
  code.textContent = value || 'Official address pending';
  button.disabled = !value;
  button.dataset.copyState = 'idle';
  button.setAttribute('aria-busy', 'false');
  label.textContent = 'Copy CA';
  status.textContent = '';

  function clearRestore() { if (timer !== null) { clearTimer(timer); timer = null; } }
  function restore() {
    timer = null;
    if (destroyed) return;
    label.textContent = 'Copy CA';
    button.dataset.copyState = 'idle';
    status.textContent = '';
  }
  async function copyAddress() {
    if (destroyed || copying || !value) return;
    copying = true; clearRestore();
    button.disabled = true; button.setAttribute('aria-busy', 'true');
    button.dataset.copyState = 'busy';
    label.textContent = 'Copying…';
    status.textContent = '';
    try {
      if (typeof clipboard?.writeText !== 'function') throw new Error('Clipboard access is unavailable.');
      await clipboard.writeText(value);
      if (destroyed) return;
      label.textContent = 'Copied'; status.textContent = 'Copied'; button.dataset.copyState = 'success';
    } catch {
      if (destroyed) return;
      label.textContent = 'Copy failed'; status.textContent = 'Select and copy the address directly'; button.dataset.copyState = 'error';
    } finally {
      if (!destroyed) {
        copying = false;
        button.disabled = false; button.setAttribute('aria-busy', 'false');
        timer = setTimer(restore, 2500);
      }
    }
  }
  button.addEventListener('click', copyAddress);
  return {
    mounted: true,
    destroy() {
      if (destroyed) return;
      destroyed = true; clearRestore();
      button.removeEventListener('click', copyAddress);
    },
  };
}
