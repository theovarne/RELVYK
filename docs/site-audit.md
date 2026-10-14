# RELVYK site audit

Audit baseline: the existing checkout before the Solana upgrade, preserved in Git. This is an incremental upgrade of that site. The inspection below is based on the repository and the locally rendered baseline; it does not claim a fresh remote test of every control at `resnomo.fun`.

## Baseline and reusable architecture

- Static HTML, CSS and vanilla JavaScript; no imported React, Next.js or Three.js dependency. The anatomy is SVG; the separate engine study combines SVG geometry with a standalone WebGL2 burn renderer. `package.json` declares ESM, Node >=18, and a single `start` script. There were no third-party runtime dependencies, lockfile, lint/typecheck/test/build scripts or compiled bundle.
- `index.html` is the page entry. `app.js` controls the browser interactions. `styles.css`, `refinement.css`, and inline SVG styles define the visual system. `serve.mjs` provided a GET/HEAD static server on localhost:4190. `vercel.json` selected a framework-free static deployment, with no build or installation command.
- Existing anchors: `#top`, `#overview`, `#engine`, `#anatomy`, `#reflexes`, `#protocol`, `#evidence`, `#build-notes`. `#overview` must continue to resolve.
- The recognizable machine is an inline isometric SVG. Six actual assemblies use `data-organ`: Eyes, Brain, Immune system, Hands, Heartbeat, Memory. The baseline uses JavaScript spring translation for explode/assemble, a path-following orb, and a rotating needle. Those assets and the original MIT license/attribution files are reusable and retained.
- The model supports organ selection and explode/assemble. It did not provide a genuine 3D orbit camera or camera zoom. Rotation/zoom must not be claimed as existing 3D capabilities.
- The baseline stops JavaScript animation when the model leaves the IntersectionObserver viewport and supports parts of reduced-motion handling. It did not use document visibility to pause all decorative activity. The orb/automatic phase cycle was a visual demo, with no task associated with it.
- State consisted of mutable browser-module variables (`selected`, `manual`, `exploded`, animation clock/springs). No task engine, persistent evidence store, RPC/API reader, Solana wallet implementation, authentication or on-chain operation existed.
- Brand copy and external links were hardcoded in HTML. The baseline included a project-looking address, a copied developer note, an X profile and a Hugging Face repository link. Existing source presence is not evidence that the address or author history belongs to the user's proposed token.
- No environment variable names or secret use appeared in the baseline application. There was no server-side data provider. Existing hosting ownership, production aliases and credentials are outside this upgrade's modification scope.

## Interaction inventory and findings

Categories: A = implemented behavior; B = visual feedback without the claimed data processing; C = empty/placeholder; D = observed failed call; E = incompatible with the new positioning.

| Baseline interaction/content | Classification | Actual behavior or finding |
| --- | --- | --- |
| Primary navigation and footer back-to-top | A | In-page anchors; mobile menu toggles and closes after navigation; IntersectionObserver updates navigation selection. |
| Hero `Inspect the anatomy` | A | Scrolls to the machine, assembles it, and triggers a short visual highlight. It is not a transaction inspection input. |
| Organ hover/click, side-console buttons and anatomy cards | A | Select a real SVG organ, update phase copy and highlight matching controls. The model also supports arrow-key selection. |
| Explode/assemble buttons and Space key | A | Translate the six assemblies using spring motion and change labels/state. Preserve this interaction with bounded labels and reset behavior. |
| Moving orb, rotating needle and automatic phase/readout cycle | B | Decorative animation. No network reads, authorization check, verification or record is performed; the replacement must label the idle machine accurately. |
| Reflex, protocol, evidence and system-release sections | B/E | Static narrative and illustrations. No runnable template, saved evidence, verification result or history replay existed. |
| Contract-address copy | A/E | Writes the hardcoded text to Clipboard and briefly says `Copied`. Clipboard rejection was not handled. The address is unconfirmed for the user's project and must not become the new project Mint configuration. |
| X/Hugging Face outbound links | E | Real URL targets exist in source, but project ownership was not established. Remove copied promotional association while retaining legal code/model attribution. Their current remote availability was not newly tested in this audit. |
| Wallet, query, template execution, snapshot comparison, export/delete | Not present | No hidden real implementation was found to reuse. These need actual modules rather than an added visual panel. |
| Empty links or failed RPC calls | C/D: none observed | Source did not contain a real RPC call to fail. A missing implementation is not reported as a successfully tested API. |

## Baseline screenshots

Captured from the existing deployed replica before editing:

- `docs/screenshots/before-first-screen.jpg`
- `docs/screenshots/before-mechanical.jpg`
- `docs/screenshots/before-content.jpg`
- `docs/screenshots/before-footer.jpg`

These record the original dark layout, existing model and content. After screenshots should compare retained identity and improved hierarchy, rather than pixel matching the old theme.

## Upgrade implementation checkpoints

- Preserve the SVG assets and mechanical identity while replacing copied narrative with the Solana read-only inspection workflow. Use one brand configuration and leave project Mint/ticker/trade destinations unconfirmed until the owner supplies them.
- `src/task-engine.js` now implements INPUT → SENSE → PLAN → AUTHORIZE → EXECUTE → VERIFY → REMEMBER from a single subscribed state. Real asynchronous reads determine progress; there is no fixed-duration simulated query. Stale reads are aborted/ignored. A failed chain transaction can be a completed inspection, while a failed source read is saved with unknown checks and an error outcome.
- `src/evidence-store.js` now persists records, snapshots and parameterized templates in IndexedDB. Unavailable storage or quota failure explicitly switches to page-session memory; it never reports persistence in that state. Deleting a snapshot's run also removes its associated saved snapshot. JSON exports preserve amount strings and source evidence.
- `src/reflex-library.js` supplies exactly three executable, versioned templates and local parameter copies. The templates select predefined transaction/Mint/snapshot code paths; stored text is never evaluated. Execution totals are derived from actual saved query records, matched to template ID and version. Replaying a record neither reads the chain nor adds an execution.
- The Solana reader is split into validation, transport, precision-preserving transaction/Mint/snapshot parsing and an exported client. Server requests must stay within the read-only allowlist, with secrets retained server-side, bounded timeouts, limited retries/cache and honest cache timestamps.
- Partial snapshots remain partial. A comparison uses two real captures of the same owner and network; absent data is not substituted with zero, historical balances, portfolio completeness or investment profit.

## Data implementation and verification

Data-module verification on 2026-10-14: **37 tests passed**, split explicitly into **31 synthetic/mock tests** and **6 captured real RPC-response replay tests**. The test command reads saved fixtures; it does not perform 37 live RPC queries. Live browser/API checks and wallet checks remain separate acceptance evidence supplied by the integration lead.

| Test file | Count | Evidence classification |
| --- | ---: | --- |
| `tests/solana.test.mjs` | 22 | Synthetic transaction/Mint/snapshot inputs and mocked browser transport. Includes exact integer parsing, version 0 loaded-address ordering, version 1 signed resource configuration, future-version rejection, chain-failure/task-success separation, null and missing fields, authority states, partial snapshots and cancellation. |
| `tests/api-proxy.test.mjs` | 9 | Explicit fake HTTP providers. Includes read-only whitelist, malformed JSON/arguments, request and streamed response bounds, numeric version 1 opt-in, timeout, bounded 429 retry, cache expiry/deduplication, retained observation timestamps and endpoint-key/error nondisclosure. |
| `tests/solana-captured.test.mjs` | 6 | Historical replay of real read-only public RPC responses captured during this task. These are not newly executed chain events or new live queries. |

The six real-response cases are: a Devnet legacy transaction; a Devnet version 0 transaction; an original Token Program Mint; a Token-2022 Mint with actual parsed extensions; that Mint's binary account inventory; and a mainnet version 1 transaction with an actual chain execution error. Raw responses and UTC capture/source provenance are retained under `tests/fixtures/solana/`, including `provenance.json`. The mainnet failed signature is `2iKX75nDizwkSm6FbZMJdBV226fTreHQwAfK1MyJyAjv6mnP9ekAsdpnqMsKMf5ytv2bshGbbWHQTuZU4SoVb1Ld`: the saved response contains version 1, `InstructionError: [0, {Custom: 12}]`, a total priority fee of 1 lamport, and signed compute/account-data limits. Its inspection completes while its chain outcome remains failed. These sample Mints are unrelated public sample addresses, not confirmed RELVYK project-token configuration.

The reader supports legacy, version 0 and version 1 through direct `jsonParsed` RPC reads with numeric `maxSupportedTransactionVersion: 1`. Version 0 lookup accounts preserve the expanded RPC account-key order; version 1 does not append ALT addresses. Version 1 resource limits come only from the signed `message.transactionConfig`, with explicit set/unset/unknown field states. Priority fee is an exact total in lamports, not a per-compute-unit price. Missing configuration remains unknown and no budget is inferred from ComputeBudget instructions. Future unsupported versions produce an explicit error. This behavior follows the current [official transaction format documentation](https://solana.com/docs/core/transactions/versioned-transactions) and [RPC JSON structure reference](https://solana.com/docs/rpc/json-structures).

All SOL/Token arithmetic preserves integer lexemes before parsing unsafe JSON numbers and uses BigInt addition/subtraction. Token quantities are formatted with their decimals. Mint identity requires a recognized Token Program and actual Mint type/layout; mint/freeze authority fields distinguish present, explicitly revoked and unavailable. Token-2022 binary TLV type IDs remain visible when RPC parsing does not cover them. No metadata URL is fetched and no safety score, price, market capitalization, Buy/Sell classification or investment profit is invented.

The server accepts only predefined networks and bounded read-only methods. RPC credentials remain in server environment variables, source labels never include endpoint keys, responses are bounded, retry count is limited, and cached reads retain their original observation time. Instance-local caches/rate counters are best-effort controls, not a claimed global service quota. Snapshot scope is public native SOL plus original/Token-2022 owned base balances; separate context slots, incomplete coverage and unknown differences are preserved. Renderer content uses DOM creation and textContent; metadata is text, raw JSON/logs are scrollable/copyable, chain failure and finality remain distinct from task completion.

At this data checkpoint, the full project TypeScript check and ESLint passed. This section does not claim real wallet connection/signing, page-session observer coverage, completed screenshots, or deployed Preview access; those require their own integration evidence.

## Final integrated acceptance

The upgraded client and native RPC Function have been built and deployed to the existing zs2/resnomo-replica project as a Preview. No production promotion was performed. Final verification details, real UTC observations, screenshot paths, exact mock coverage and configuration boundaries are recorded in [verification-report.md](verification-report.md).

106 automated tests passed, alongside full-project ESLint and CheckJS/TypeScript checks and the production build. Six tests replay captured real RPC responses; 97 use synthetic data/mocks (including Wallet Standard, observer, lifecycle, failure and IndexedDB simulations), and three verify pure UI export/URL/date boundaries. These are not 106 live chain executions.

Live integrated browser reads covered successful legacy and v0 Devnet transactions, a failed mainnet v1 transaction, original Token Program and Token-2022 Mints, revoked permissions, a non-Mint account, an unavailable transaction and two same-account snapshots. The deployed Preview separately completed real Devnet legacy and mainnet v1 reads through its server Function. Parameter-copy runs, history replay without extra records, export, copy feedback, record restoration and dialog closure were checked in the browser. Deletion and wallet connection/rejection/account changes are explicitly mock-tested; the real browser detected no installed compatible wallet.

The 1440px, 1920px and 390px views had matching document scroll/client widths, with retained mechanical geometry. Model selection, keyboard stage/result navigation, explode/assemble/reset, mobile navigation and matching Docs styling were exercised. Reduced-motion and hidden/offscreen lifecycle cases are covered by mock media-query/visibility tests; no user OS preference was changed. Project Mint/ticker/trade URL remain unconfirmed and their observer is gated off.
