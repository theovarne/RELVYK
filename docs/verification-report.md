# RELVYK Upgrade Delivery and Verification

Delivery date: 2026-10-14. All on-chain observation times use UTC. This report summarizes the implemented code, browser checks, and deployment results, distinguishing live queries, replay of captured real responses, and mock tests.

## Implemented Changes

- Upgraded the existing static HTML/CSS/JavaScript project while retaining its six-part isometric SVG anatomy, mechanical engine display, selection, exploded view, reset, and keyboard controls. Applied warm white, graphite, cobalt blue, and restrained deep mint green, and reorganized Overview, Inspect, Engine, Reflexes, Evidence, and Docs.
- Established a single task state: INPUT → SENSE → PLAN → AUTHORIZE → EXECUTE → VERIFY → REMEMBER. Stages, model feedback, checks, and records share the same source. Results appear when the query completes; cancellation and new inputs invalidate stale responses.
- Implemented real read-only transaction inspection, Mint properties and authorities, Token-2022 extension reads, account snapshots, and comparisons for the same account on the same network. Preserved raw responses, unknown fields, failure reasons, and integer precision. On-chain transaction failure is recorded separately from successful completion of its inspection.
- Implemented three usable Reflex templates, parameterized copies, search and filtering, actual execution counts, and version isolation. Transaction checks use version `1.1.0`, supporting legacy/v0/v1 transactions and checks of signed version 1 resource configuration. Mint and Snapshot templates use version `1.0.0`.
- Implemented IndexedDB evidence storage, step replay, JSON export, record deletion, and deletion of associated snapshots. Replay creates no new queries or execution counts. When persistent storage is unavailable, the interface explicitly identifies page-session memory storage.
- Implemented Wallet Standard discovery, connection state, and a cancellable page-session observation queue. Ordinary queries require neither a wallet nor a signature and send no asset transactions. Removed the reference site's developer biography, promotional links, and unconfirmed project CA while preserving third-party licenses.

## Real API and Browser Results

The following read-only queries were completed in the local browser through real RPC endpoints. All addresses are verification samples and **are not the RELVYK project Mint**.

| Sample | Network and result |
| --- | --- |
| Legacy transaction `5TWqTumm…gs5SfPJS` | Devnet, slot `510983971`; inspection completed. |
| v0 transaction `2f8FEwP4…b9iamcz` | Devnet, slot `510983995`; versioned accounts and instructions were parsed. |
| Failed v1 transaction `2iKX75nD…SoVb1Ld` | Mainnet Beta, slot `456844515`, finalized. The on-chain error was Instruction 0 / Custom 12. Inspection completed without presenting the on-chain transaction as successful. |
| Original Token Program Mint `Aj1…` | Supply `1501030000`, decimals `6`; Mint Authority confirmed present and Freeze Authority confirmed revoked. |
| Token-2022 Mint `7mqdwH6yrbUZcx4jKomAYG2A6mEnuf4hdH5yt4XM14gv` | Supply observed in this browser session: `747018364.316342795`. Extension types `18/3/19` were read, with coverage and limitations displayed. Supply may change between observations. |
| Native SOL Mint `So11111111111111111111111111111111111111112` | Both Mint Authority and Freeze Authority were confirmed revoked. |
| Wallet address `AVm…` | Identified as a non-Mint account; missing authority fields were not interpreted as revoked authorities. |
| Transaction query on a mismatched network | RPC returned null. The interface stated that the source had not returned a record, without claiming the transaction had never existed. |
| Two Devnet snapshots of the same account `AVm…` | Actual observation times: `2026-10-14T12:56:43.472Z` and `2026-10-14T13:02:56.396Z`. SOL change: `-11.427290083`; the Token query returned an empty collection. The difference was not described as profit, and complete portfolio coverage was not claimed. |

The deployed Preview also completed two independent real browser queries through its native `/api/rpc` endpoint:

- Devnet legacy transaction: observed at `2026-10-14T13:20:52.537Z`. The full signature, source, checks, timeline, and raw evidence are available in [live-preview-transaction.json](evidence/live-preview-transaction.json).
- Failed Mainnet v1 transaction: observed at `2026-10-14T13:26:22.796Z`, finalized, with Instruction 0 / Custom 12 preserved. Full evidence is available in [live-preview-mainnet-v1.json](evidence/live-preview-mainnet-v1.json).

Real browser checks also covered the homepage CTA focusing the actual input field, navigation and return from Docs, keyboard selection/explosion/reset of the model, keyboard operation of result tabs, IndexedDB restoration, copy feedback, and JSON export. On Preview, a saved parameterized template initially showed 0 executions and showed 1 after an actual Run. Replay left the record count at 2. The deletion dialog's Keep record action closed the dialog correctly.

## Automated Tests, Engineering Checks, and Limitations

All **106 automated tests passed**: 6 replay captured real RPC responses, 97 use mock or synthetic data, and 3 check UI export, URL, and date boundaries. Real responses and capture times are recorded in `tests/fixtures/solana/provenance.json`. Their replay is not a new live query.

ESLint, CheckJS/TypeScript type checking, and the production build all exited with code 0. The released client contained 31 allowlisted files, with zero matches for private paths, tests, environment configuration, the old CA, or secrets. The native RPC Function was 7.87 KB. Checks were not disabled, tests were not removed, and random live data was not generated.

The following were verified only with mock or synthetic tests, without claiming real wallet or live on-chain verification: wallet connection/rejection/disconnection/account switching, multiple-wallet discovery, actual record deletion, timeouts/rate limits/cache expiry/stale inputs, unavailable local storage/quota failures, and duplicate observation events and queue handling. The browser detected no compatible wallet, so no real wallet signature was obtained. Reduced-motion behavior was checked with mocks; the user's operating system settings were not changed.

The project Mint is currently null and the project observation feature is false. No real project-token event monitoring was run. Holder gating and the authenticated cloud workspace are disabled. There is no continuous background execution, return guarantee, trading, custody, or Mainnet asset operation.

## Configuration and Key Files

- `src/config.js`: unified brand and feature configuration. `tokenConfig.mint/ticker/tradeUrl` are currently null. Once the project CA is confirmed, set the confirmed Mint, network, and valid links here. Enable `features.projectTokenObserver` explicitly if bounded session observation is required. Holder access and authentication still require real service-side enforcement.
- `.env.example`: optional server-only `SOLANA_MAINNET_RPC_URL`, `SOLANA_DEVNET_RPC_URL`, and `SOLANA_TESTNET_RPC_URL`. The default public RPC endpoints passed real queries, so core features require no additional keys. A hosted RPC provider can improve quotas and availability; its keys must not be exposed to the client.
- Interface and model: `index.html`, `app.css`, `app.js`, `docs.html`, `model.css`, `src/model-controller.js`, `src/result-view.js`, `src/ui-helpers.js`, and `figures/verification-engine.html`.
- Features and data: `src/task-engine.js`, `src/evidence-store.js`, `src/reflex-library.js`, `src/solana/`, `src/wallet-service.js`, `src/session-observer.js`, `src/observation-queue.js`, and `api/rpc.js`.
- Engineering: `package.json`, the lockfile, `eslint.config.js`, `tsconfig.json`, `scripts/build.mjs`, `serve.mjs`, `vercel.json`, and `tests/`. See [site-audit.md](site-audit.md) for the baseline audit.

## Screenshots and Preview

The 1440px, 1920px, and 390px layouts were checked with no horizontal overflow. Screenshots include the [1440px homepage](screenshots/after-1440.jpg), [1920px homepage](screenshots/after-1920.jpg), [1440px workspace](screenshots/after-workbench-1440.jpg), [1920px workspace](screenshots/after-workbench-1920.jpg), [narrow-screen homepage](screenshots/after-mobile.jpg), [narrow-screen workspace](screenshots/after-mobile-workbench.jpg), [content](screenshots/after-content.jpg), [footer](screenshots/after-footer.jpg), [Docs](screenshots/after-docs.jpg), and [real Mainnet v1 query](screenshots/after-live-mainnet-v1.jpg). Before-change screenshots are retained in the same directory.

Accessible [Preview](https://resnomo-replica-8p8k3n3f3-zs2.vercel.app/): deployed to the existing `zs2/resnomo-replica` project. Deployment `dpl_9v7qkjEMbsPCxhyUTdrGo2zC4YRn` was READY and explicitly targeted Preview. No production domain was promoted, and ownership and DNS were unchanged. This report and the source archive were prepared after deployment; neither the report nor the new avatar triggered another deployment.

The source archive `resnomo-solana-upgrade.zip` contains source code, tests, licenses, screenshots, and verification evidence. It excludes `.git`, `node_modules`, the `public` build directory, `.vercel`, actual `.env*` files, logs, work files, and credentials, while retaining the blank `.env.example`. The subsequently generated avatar is a separate asset: it was not added to the existing website or included in this source archive.
