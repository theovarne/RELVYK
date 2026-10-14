import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'public');
const files = ['index.html', 'docs.html', '404.html', 'app.js', 'app.css', 'model.css', 'src', 'assets/relvyk-logo.png', 'assets/relvyk-icon.png', 'assets/brand/x.svg', 'assets/brand/github.svg', 'figures/verification-engine.html', 'figures/inter.woff2', 'LICENSE', 'LICENSE-anatomy', 'LICENSE-octicons'];
for (const file of files) await stat(resolve(root, file));
const page = await readFile(resolve(root, 'index.html'), 'utf8');
if (/4o2PSdoR8KpViHZhDSeuUQDT3m4wemTkqysSrNWXpump|resnomonx|I have spent a lot of time|__MODEL__/.test(page)) throw new Error('Reference identity or an unresolved model placeholder remains in the page.');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of files) { const target = resolve(output, file); await mkdir(dirname(target), { recursive: true }); await cp(resolve(root, file), target, { recursive: true }); }
await writeFile(resolve(output, 'build.json'), JSON.stringify({ name: 'RELVYK', version: '2.0.0', htmlSha256: createHash('sha256').update(page).digest('hex'), clientSecrets: false }));
console.log(`Built RELVYK static client: ${output}. The read-only RPC Function stays server-side.`);
