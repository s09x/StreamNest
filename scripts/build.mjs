import { build } from 'esbuild';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const prelude = await readFile(resolve(root, 'src/native/polyfills.js'), 'utf8');
const definitions = [
  { id: 'streamnest-filmpalast', name: 'StreamNest | Filmpalast', entry: 'filmpalast', types: ['movie', 'tv'], hasSettings: false },
  { id: 'streamnest-filmo', name: 'StreamNest | Filmo', entry: 'filmo', types: ['movie'], hasSettings: false },
  { id: 'streamnest-xtream', name: 'StreamNest | Xtream VOD', entry: 'xtream', types: ['movie', 'tv'], hasSettings: true },
];
const bundledPackages = new Set();
const artifacts = [];

await mkdir(resolve(root, 'providers'), { recursive: true });
for (const provider of definitions) {
  const result = await build({
    entryPoints: [resolve(root, `src/entries/${provider.entry}.ts`)], bundle: true,
    platform: 'browser', format: 'iife', globalName: 'StreamNestProvider', target: 'es2020', minify: true,
    legalComments: 'eof', define: { 'process.env.NODE_ENV': '"production"' }, write: false, metafile: true,
    banner: { js: prelude },
    footer: { js: 'module.exports = StreamNestProvider;' },
  });
  const output = result.outputFiles[0];
  if (!output || output.contents.byteLength > 1024 * 1024) throw new Error('Native provider bundle exceeds the packaging budget.');
  if (/\brequire\(["'](?:node:|fs["']|http["']|https["'])/.test(output.text)) throw new Error('A Node dependency entered a native provider.');
  artifacts.push([resolve(root, `providers/${provider.entry}.js`), output.contents]);
  const includedInputs = new Set(Object.values(result.metafile.outputs).flatMap(file =>
    Object.entries(file.inputs).filter(([, contribution]) => contribution.bytesInOutput > 0).map(([input]) => input)));
  for (const input of includedInputs) {
    const normalized = input.replaceAll('\\', '/');
    const marker = normalized.lastIndexOf('node_modules/');
    if (marker < 0) continue;
    const tail = normalized.slice(marker + 'node_modules/'.length).split('/');
    const name = tail[0].startsWith('@') ? tail.slice(0, 2).join('/') : tail[0];
    bundledPackages.add(name);
  }
}

const notices = ['# Third-party runtime notices', '', 'These packages are bundled into the native provider JavaScript files. Development-only packages are not included here.', ''];
for (const name of [...bundledPackages].sort()) {
  const directory = resolve(root, 'node_modules', name);
  const metadata = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const licenseFile = (await readdir(directory)).find(file => /^(?:license|licence|copying)(?:[._-][\w-]+)?$/i.test(file));
  const licensePath = licenseFile ? resolve(directory, licenseFile)
    : resolve(root, 'scripts/licenses', `${name.replaceAll('/', '_')}-${metadata.version}.txt`);
  let license;
  try { license = await readFile(licensePath, 'utf8'); }
  catch { throw new Error(`Missing runtime dependency license: ${name}`); }
  const noticeText = license.replace(/\r\n/g, '\n').replace(/[\t ]+$/gm, '').trim();
  notices.push(`## ${name} ${metadata.version}`, '', `License: ${metadata.license ?? 'See the notice below.'}`, '', '```text', noticeText, '```', '');
}
artifacts.push([resolve(root, 'THIRD_PARTY_NOTICES.md'), notices.join('\n')]);
for (const [path, contents] of artifacts) await writeFile(path, contents);

await writeFile(resolve(root, 'manifest.json'), JSON.stringify({
  name: 'StreamNest', version: pkg.version,
  description: 'Native Nuvio providers for German movies and series, including user-configured Xtream VOD.',
  author: 's09x',
  scrapers: definitions.map(provider => ({
    id: provider.id, name: provider.name, version: pkg.version,
    filename: `providers/${provider.entry}.js`, supportedTypes: provider.types,
    contentLanguage: ['de'], hasSettings: provider.hasSettings,
  })),
}, null, 2) + '\n');
