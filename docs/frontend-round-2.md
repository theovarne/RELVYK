# RELVYK — Second Frontend Upgrade

## Scope

This iteration retained the warm-white, graphite and cobalt palette and the original mechanical geometry. It added a mechanical introduction with entry and skip controls, explicit selection state, a structural tour, Assembly / Exploded / Trace views, a continuous explode control, SVG 2D focus, an expanded workbench, a bidirectional processing blueprint, pausable replay with individual step selection, two historical examples with identified sources, capability dossiers for the three task types, and a layered evidence drawer.

The RPC protocol, task engine, wallet permissions, contract address and ticker were unchanged. This iteration was deployed as a Preview; it was not promoted to production.

## Browser verification

The following interactions were exercised in the browser:

- Advance and close the tour while the task remains **Awaiting input**.
- Select and focus mechanical parts; use actual SVG `viewBox` zoom, reset, and keyboard controls to set the explode amount to **50%**.
- Link the blueprint's **VERIFY** stage to the corresponding interface state.
- Expand the workbench, exit it, and use **Esc**.
- Open the historical examples, use **Play / Pause**, move to previous and next steps, and scrub to **REMEMBER**. The local record count remained **5** before and after replay.
- Select a check and display its exact evidence field, `result.raw.transaction.meta.err`; close the evidence drawer.
- Search Reflexes, expand their checks, and clear the search.
- Copy JSON and observe successful copy feedback.
- Complete one real Devnet query while preserving the user's selected **Verification gauge**.

The document had no horizontal overflow at viewport widths of **1440px**, **1920px**, and **390px**.

## Automated checks and coverage limits

All **124 automated tests passed**, as did lint, type checking, the build, and inline-script syntax checks.

Isolated hover behavior and the operating system's reduced-motion setting were not independently exercised in a browser session. Existing simulated pointer, media-query and visibility tests cover those cases. The historical examples replay existing real records; they are not additional live queries or new executions.

## Key files

`app.js`, `app.css`, `index.html`, `src/model-controller.js`, `src/engine-blueprint.js`, `src/experience-ui.js`, `src/replay-controller.js`, `src/recorded-examples.js`, `src/reflex-dossiers.js`, and `src/evidence-panel.js`.

## Screenshots

- [Overview before the upgrade](screenshots/round-2/before-overview.jpg) / [Overview after the upgrade](screenshots/round-2/after-overview.jpg)
- [Workbench before the upgrade](screenshots/round-2/before-engine.jpg) / [Assembly view](screenshots/round-2/after-engine-assembly.jpg)
- [Exploded view](screenshots/round-2/after-engine-exploded.jpg) / [Expanded workbench](screenshots/round-2/after-expanded-workspace.jpg)
- [Evidence drawer](screenshots/round-2/after-evidence-drawer.jpg) / [1920px desktop](screenshots/round-2/after-engine-1920.jpg) / [390px narrow viewport](screenshots/round-2/after-mobile-engine.jpg)

## Historical Preview acceptance

The final Preview for this iteration was [the mechanical workbench](https://resnomo-replica-cl54g9163-zs2.vercel.app/#engine). Vercel reported **READY**. It remained a Preview of the existing project and did not replace production.

The deployed page was opened and its **Expand / Exit** controls were exercised. Exiting through the visible control restored the scroll position with a measured difference of **0**. The final capture is preserved as [the deployed workbench](screenshots/round-2/after-final-preview.jpg).
