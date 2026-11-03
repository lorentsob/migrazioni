// Asset statici di Next (/_next/static) per il rilascio unico (fase B3).
// Il manifest ha lo stesso formato letto da coolify/scripts/generate-failover-allowlist-config.mjs:
//   { version: 1, revision, files: [{ path: '/_next/static/...', size, sha256 }] }
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PREFIX = '/_next/static/';
// File aggiunto dall'adattatore Vercel in .vercel/output/static/_next/static:
// non è un asset di Next. Ammesso solo con questo contenuto esatto.
export const VERCEL_SENTINEL = { name: 'not-found.txt', content: 'Not Found' };
const SHA = /^[a-f0-9]{64}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const okSegment = s => s && s !== '.' && s !== '..' && !/[\\\x00-\x1f\x7f?#%]/.test(s);

async function walk(root, { skipSentinel = false } = {}) {
  const top = await lstat(root);
  if (top.isSymbolicLink() || !top.isDirectory()) throw new Error(`cartella asset non valida: ${root}`);
  const files = new Map();
  async function visit(rel) {
    for (const name of (await readdir(join(root, rel))).sort()) {
      if (!okSegment(name)) throw new Error(`nome asset non valido: ${rel}/${name}`);
      const relPath = rel ? `${rel}/${name}` : name;
      const info = await lstat(join(root, relPath));
      if (info.isSymbolicLink()) throw new Error(`link simbolico rifiutato: ${relPath}`);
      if (info.isDirectory()) { await visit(relPath); continue; }
      if (!info.isFile()) throw new Error(`file non regolare: ${relPath}`);
      const bytes = await readFile(join(root, relPath));
      if (skipSentinel && relPath === VERCEL_SENTINEL.name) {
        if (bytes.toString('utf8') !== VERCEL_SENTINEL.content) throw new Error('sentinella Vercel con contenuto inatteso');
        continue;
      }
      files.set(relPath, { size: bytes.length, sha256: sha256(bytes) });
    }
  }
  await visit('');
  return files;
}

/** Manifest di una cartella _next/static. `vercel: true` tollera solo la sentinella esatta. */
export async function buildManifest(root, revision, { vercel = false } = {}) {
  if (typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('revisione: serve il commit completo');
  const files = await walk(root, { skipSentinel: vercel });
  return { version: 1, revision, files: [...files].map(([p, v]) => ({ path: PREFIX + p, ...v })).sort((a, b) => a.path.localeCompare(b.path, 'en')) };
}

export function checkManifest(m) {
  if (!m || m.version !== 1 || !/^[a-f0-9]{40}$/.test(m.revision || '') || !Array.isArray(m.files)) throw new Error('manifest non valido');
  const seen = new Set();
  for (const f of m.files) {
    if (!f || typeof f.path !== 'string' || !f.path.startsWith(PREFIX) || !f.path.slice(PREFIX.length).split('/').every(okSegment)) throw new Error('percorso non valido nel manifest');
    if (seen.has(f.path)) throw new Error(`percorso duplicato: ${f.path}`);
    seen.add(f.path);
    if (!Number.isSafeInteger(f.size) || f.size < 0 || !SHA.test(f.sha256)) throw new Error(`integrità non valida: ${f.path}`);
  }
  return m;
}

/** Hash dell'insieme (percorso, dimensione, sha256), indipendente da ordine e revisione. */
export function setDigest(m) {
  checkManifest(m);
  return sha256(JSON.stringify([...m.files].sort((a, b) => a.path.localeCompare(b.path, 'en')).map(f => [f.path, f.size, f.sha256])));
}

/** Differenze fra due manifest: mancanti in b, in più in b, diversi. */
export function compareManifests(a, b) {
  checkManifest(a); checkManifest(b);
  const mb = new Map(b.files.map(f => [f.path, f]));
  const ma = new Map(a.files.map(f => [f.path, f]));
  const missing = [], different = [], extra = [];
  for (const f of a.files) {
    const g = mb.get(f.path);
    if (!g) missing.push(f.path); else if (g.sha256 !== f.sha256 || g.size !== f.size) different.push(f.path);
  }
  for (const f of b.files) if (!ma.has(f.path)) extra.push(f.path);
  return { equal: !missing.length && !different.length && !extra.length, missing, extra, different };
}

/**
 * Unisce in `destination` i file `retained` (manifest + cartella sorgente di una release
 * precedente). Verifica gli hash della sorgente; stesso percorso con contenuto diverso = errore,
 * prima di scrivere qualsiasi file. Non sovrascrive mai.
 */
export async function mergeRetained(destination, retained) {
  const current = await walk(destination, { skipSentinel: true });
  const plan = new Map();
  for (const { manifest, root } of retained) {
    checkManifest(manifest);
    const source = await walk(root);
    for (const f of manifest.files) {
      const rel = f.path.slice(PREFIX.length);
      const have = source.get(rel);
      if (!have || have.sha256 !== f.sha256 || have.size !== f.size) throw new Error(`asset conservato mancante o alterato: ${f.path}`);
      const already = current.get(rel) || plan.get(rel)?.f;
      if (already && (already.sha256 !== f.sha256 || already.size !== f.size)) throw new Error(`collisione asset: ${f.path}`);
      if (!current.has(rel) && !plan.has(rel)) plan.set(rel, { f, from: join(root, rel) });
    }
  }
  for (const [rel, { f, from }] of plan) {
    const to = join(destination, rel);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to, constants.COPYFILE_EXCL);
    if (sha256(await readFile(to)) !== f.sha256) throw new Error(`copia non verificata: ${f.path}`);
  }
  return { added: plan.size };
}

async function main([cmd, ...args]) {
  if (cmd === 'manifest') {
    const [root, revision, out, flag] = args;
    const m = await buildManifest(root, revision, { vercel: flag === '--vercel' });
    await writeFile(out, `${JSON.stringify(m, null, 2)}\n`, { flag: 'wx' });
    return { files: m.files.length, setDigest: setDigest(m) };
  }
  if (cmd === 'confronta') {
    const [a, b] = await Promise.all(args.slice(0, 2).map(async p => JSON.parse(await readFile(p, 'utf8'))));
    const r = compareManifests(a, b);
    if (!r.equal) { const e = new Error('insiemi di asset diversi'); e.details = { missing: r.missing.length, extra: r.extra.length, different: r.different.length, esempi: [...r.missing, ...r.extra, ...r.different].slice(0, 5) }; throw e; }
    return { equal: true, files: a.files.length };
  }
  if (cmd === 'impronta') {
    process.stdout.write(`${setDigest(JSON.parse(await readFile(args[0], 'utf8')))}\n`);
    return null;
  }
  if (cmd === 'unisci') {
    // unisci <destinazione> <manifest-1> <cartella-1> [<manifest-2> <cartella-2> ...]
    const [dest, ...pairs] = args;
    if (!dest || !pairs.length || pairs.length % 2) throw new Error('uso: unisci DEST MANIFEST DIR [MANIFEST DIR ...]');
    const retained = [];
    for (let i = 0; i < pairs.length; i += 2) retained.push({ manifest: JSON.parse(await readFile(pairs[i], 'utf8')), root: pairs[i + 1] });
    return mergeRetained(dest, retained);
  }
  throw new Error('comandi: manifest | confronta | unisci');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(r => { if (r !== null) console.log(JSON.stringify(r)); })
    .catch(e => { console.error(`asset: ${e.message}${e.details ? ' ' + JSON.stringify(e.details) : ''}`); process.exitCode = 1; });
}
