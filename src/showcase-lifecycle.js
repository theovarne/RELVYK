const STATE_MESSAGE = 'relvyk:showcase-visibility';
const READY_MESSAGE = 'relvyk:showcase-ready';
const observer = callback => typeof IntersectionObserver === 'function' ? new IntersectionObserver(callback, { rootMargin: '0px' }) : null;

/**
 * @param {Element} element
 * @param {{documentTarget?: Document, windowTarget?: Window & typeof globalThis, mediaQuery?: MediaQueryList, observerFactory?: (callback: IntersectionObserverCallback) => Pick<IntersectionObserver, 'observe' | 'disconnect'> | null, onActiveChange?: (active: boolean) => void, onMotionChange?: (reduced: boolean) => void}} [options]
 */
export function createShowcaseLifecycle(element, { documentTarget = document, windowTarget = window, mediaQuery = windowTarget.matchMedia('(prefers-reduced-motion: reduce)'), observerFactory = observer, onActiveChange = () => {}, onMotionChange = () => {} } = {}) {
  let localVisible = false, parentVisible = true, active = false, destroyed = false;
  const refresh = () => {
    if (destroyed) return;
    const next = localVisible && parentVisible && documentTarget.visibilityState !== 'hidden';
    if (active !== next) { active = next; onActiveChange(active); }
  };
  const intersection = observerFactory(entries => { localVisible = Boolean(entries.at(-1)?.isIntersecting); refresh(); });
  if (intersection) intersection.observe(element); else localVisible = true;
  const message = event => {
    if (event.source !== windowTarget.parent || event.origin !== windowTarget.location.origin || event.data?.type !== STATE_MESSAGE || typeof event.data.visible !== 'boolean') return;
    parentVisible = event.data.visible; refresh();
  };
  const motion = () => { onMotionChange(mediaQuery.matches); refresh(); };
  documentTarget.addEventListener('visibilitychange', refresh);
  windowTarget.addEventListener('message', message);
  mediaQuery.addEventListener('change', motion);
  refresh();
  if (windowTarget.parent !== windowTarget) windowTarget.parent.postMessage({ type: READY_MESSAGE }, windowTarget.location.origin);
  return {
    refresh,
    getState: () => ({ active, localVisible, parentVisible, reducedMotion: mediaQuery.matches }),
    destroy() {
      if (destroyed) return;
      destroyed = true; intersection?.disconnect();
      documentTarget.removeEventListener('visibilitychange', refresh); windowTarget.removeEventListener('message', message); mediaQuery.removeEventListener('change', motion);
      if (active) { active = false; onActiveChange(false); }
    },
  };
}

/**
 * @param {HTMLIFrameElement} iframe
 * @param {{documentTarget?: Document, windowTarget?: Window & typeof globalThis, observerFactory?: (callback: IntersectionObserverCallback) => Pick<IntersectionObserver, 'observe' | 'disconnect'> | null}} [options]
 */
export function createShowcaseVisibilityBridge(iframe, { documentTarget = document, windowTarget = window, observerFactory = observer } = {}) {
  let visible = false, destroyed = false;
  const refresh = () => {
    if (!destroyed) iframe.contentWindow?.postMessage({ type: STATE_MESSAGE, visible: visible && documentTarget.visibilityState !== 'hidden' }, windowTarget.location.origin);
  };
  const intersection = observerFactory(entries => { visible = Boolean(entries.at(-1)?.isIntersecting); refresh(); });
  if (intersection) intersection.observe(iframe); else visible = true;
  const ready = event => { if (event.source === iframe.contentWindow && event.origin === windowTarget.location.origin && event.data?.type === READY_MESSAGE) refresh(); };
  iframe.addEventListener('load', refresh); documentTarget.addEventListener('visibilitychange', refresh); windowTarget.addEventListener('message', ready); refresh();
  return { refresh, destroy() {
    if (destroyed) return;
    iframe.contentWindow?.postMessage({ type: STATE_MESSAGE, visible: false }, windowTarget.location.origin);
    destroyed = true; intersection?.disconnect(); iframe.removeEventListener('load', refresh); documentTarget.removeEventListener('visibilitychange', refresh); windowTarget.removeEventListener('message', ready);
  } };
}
