export const brandConfig = Object.freeze({
  name: 'RELVYK',
  description: 'A verifiable reflex engine for Solana.',
  siteUrl: 'https://relvyk.xyz',
  logo: '/assets/relvyk-logo.png',
  socialLinks: [{ name: 'GitHub', url: 'https://github.com/theovarne/RELVYK' }],
});

// Set only after the project owner explicitly confirms the Mint and network.
// No address from the reference website is treated as a project asset.
export const tokenConfig = Object.freeze({
  network: 'mainnet-beta',
  // Single source for the homepage RELVYK CA. Leave null until officially provided.
  mint: null,
  ticker: null, tradeUrl: null,
  holderAccessEnabled: false, holderThreshold: null,
});

export const features = Object.freeze({
  transactionInspector: true, tokenAnatomy: true, snapshotCompare: true,
  localEvidence: true, projectTokenObserver: false, authenticatedWorkspace: false,
});

export const networks = Object.freeze([
  { id: 'mainnet-beta', label: 'Mainnet Beta' },
  { id: 'devnet', label: 'Devnet' },
  { id: 'testnet', label: 'Testnet' },
]);
