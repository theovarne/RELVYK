const STAGES = ['SENSE', 'PLAN', 'AUTHORIZE', 'EXECUTE', 'VERIFY', 'REMEMBER'];
const TOUR = [
 ['Optical assembly', 'Receive an input and identify its selected network. This guide shows structure without querying the chain.'],
 ['Planning rotor', 'Choose a predefined route. The blueprint describes the six connected stages; no model inference is required.'],
 ['Permission lock', 'A read-only boundary keeps public inspection separate from asset authorization.'],
 ['Tool actuator', 'A real task reads and parses returned RPC data here. Exploring the mechanism does not execute that task.'],
 ['Verification gauge', 'Defined checks distinguish pass, finding and unknown. Select a recorded example to inspect their actual evidence.'],
 ['Memory archive', 'A completed observation can be saved in this browser and replayed. A reusable route is a Reflex.'],
];
/** Frontend view controls; no chain calls, records or account permissions. */
export function createExperienceUI({ model, workspace, onTourChange, root = document }) {
  let expanded = false, tourIndex = -1, savedScroll = 0, savedFocus = null, placeholder = null;
  const subscriptions = [];
  /** @template {keyof import('./ui-types.js').UIElements} K @param {K} id @returns {import('./ui-types.js').UIElements[K]} */
  const byId = id => /** @type {import('./ui-types.js').UIElements[K]} */ (root.getElementById(id));
  const listen = (target,event,callback,options = undefined) => { target?.addEventListener(event,callback,options); subscriptions.push(()=>target?.removeEventListener(event,callback,options)); };
  function renderTour() {
    byId('tour-panel').hidden = tourIndex < 0;
    workspace.classList.toggle('is-touring',tourIndex >= 0);
    if (tourIndex >= 0) {
      workspace.dataset.tourStage = STAGES[tourIndex];
      byId('tour-title').textContent = TOUR[tourIndex][0]; byId('tour-description').textContent = TOUR[tourIndex][1];
      byId('tour-position').textContent = `${tourIndex+1} / 6`;
      byId('tour-prev').disabled = tourIndex === 0;
      byId('tour-next').textContent = tourIndex === 5 ? 'Finish tour' : 'Next →';
      model.select(STAGES[tourIndex]);
    } else delete workspace.dataset.tourStage;
    onTourChange?.(tourIndex >= 0, tourIndex >= 0 ? STAGES[tourIndex] : null);
  }
  function stopTour() { tourIndex = -1; renderTour(); }
  function startTour() { tourIndex = 0; model.setView('exploded'); renderTour(); workspace.scrollIntoView({behavior:'smooth',block:'start'}); byId('tour-next').focus({preventScroll:true}); }
  function expand(force) {
    const next = typeof force === 'boolean' ? force : !expanded;
    if (next === expanded) return;
    if (next) { savedScroll = window.scrollY; savedFocus = root.activeElement; placeholder=root.createElement('div');placeholder.style.height=`${workspace.getBoundingClientRect().height}px`;placeholder.setAttribute('aria-hidden','true');workspace.before(placeholder); }
    expanded = next; workspace.classList.toggle('is-expanded',expanded); root.body.classList.toggle('workspace-expanded',expanded);
    workspace.setAttribute('role',expanded ? 'dialog' : 'region');
    workspace.setAttribute('aria-label','Mechanical engine workspace');
    if (expanded) workspace.setAttribute('aria-modal','true'); else workspace.removeAttribute('aria-modal');
    byId('expand-workspace').textContent = expanded ? 'Exit Workspace ↙' : 'Expand Workspace ↗';
    byId('expand-workspace').setAttribute('aria-expanded',String(expanded));
    if (expanded) byId('expand-workspace').focus();
    else { placeholder?.remove();placeholder=null; window.scrollTo({top:savedScroll,behavior:'instant'}); savedFocus?.focus?.({preventScroll:true});requestAnimationFrame(()=>window.scrollTo({top:savedScroll,behavior:'instant'})); }
  }
  listen(byId('take-tour'),'click',startTour);
  listen(byId('tour-prev'),'click',()=>{tourIndex = Math.max(0,tourIndex-1);renderTour();});
  listen(byId('tour-next'),'click',()=>{ if(tourIndex===5) stopTour(); else {tourIndex++;renderTour();} });
  listen(byId('tour-close'),'click',stopTour);
  listen(byId('expand-workspace'),'click',()=>expand());
  listen(byId('skip-intro'),'click',()=>{ root.querySelector('.hero-machine')?.classList.add('entrance-skipped'); root.querySelector('iframe')?.contentWindow?.postMessage({type:'relvyk:skip-entrance'},window.location.origin); byId('skip-intro').textContent='Entrance skipped'; });
  listen(root,'keydown',event=>{
    if(root.querySelector('dialog[open]')) return;
    if(event.key==='Escape' && (expanded || tourIndex>=0)) {event.preventDefault();event.stopPropagation();if(expanded)expand(false);else stopTour();}
    if(event.key==='Tab' && expanded) {
      const controls=[...workspace.querySelectorAll('button,input,select,a[href],summary,[tabindex="0"]')].filter(item=>!item.disabled&&item.getClientRects().length);
      const first=controls[0],last=controls.at(-1);
      if(event.shiftKey&&root.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&root.activeElement===last){event.preventDefault();first?.focus();}
    }
  },true);
  const iframe=/** @type {HTMLIFrameElement} */ (root.querySelector('.hero-machine iframe'));
  listen(window,'message',event=>{
    if(event.source!==iframe?.contentWindow||event.origin!==window.location.origin||event.data?.type!=='relvyk:study-state')return;
    const data=event.data;
    if(typeof data.name!=='string'||data.name.length>100||!['Assembly','Exploded','Ignition study'].includes(data.view))return;
    byId('hero-view').textContent=data.view;byId('hero-selected').textContent=`${data.index ? String(data.index).padStart(2,'0')+' / ' : ''}${data.name}`;
  });
  return {startTour,stopTour,expand,getState:()=>({expanded,tourActive:tourIndex>=0,tourIndex}),destroy(){subscriptions.forEach(unsubscribe=>unsubscribe()); if(expanded)expand(false);}};
}
