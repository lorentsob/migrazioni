// Passo 4 (PRE-CHECK) del rilascio unico. Controlla un'origine (container dell'immagine
// per digest, oppure il deployment Vercel non ancora promosso) contro il manifest:
// health = commit, pagine 200, OGNI asset del manifest con hash identico, ottimizzatore immagini.
// Nessuna promozione: se fallisce, non è stato promosso nulla.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkManifest } from './asset.mjs';

const LIMITE = 32 * 1024 * 1024;

/**
 * Lettore HTTP. Per il container locale basta la base; per un deployment Vercel non
 * promosso serve l'header di "Protection Bypass for Automation" (gli URL generati sono
 * protetti dal login Vercel: verificato in B3, risposta 302 verso vercel.com/sso-api).
 */
export function lettoreHttp(base, { fetchFn = fetch, bypass = null } = {}) {
  const origin = new URL(base).origin;
  const extra = bypass ? { 'x-vercel-protection-bypass': bypass } : {};
  return async path => {
    const r = await fetchFn(new URL(path, origin), { redirect: 'manual', headers: { accept: 'text/html,*/*', ...extra } });
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > LIMITE) throw new Error('risposta troppo grande');
    return { status: r.status, body };
  };
}

export async function precheck({ leggi, manifest, commit, pagine = ['/'], immagineDiProva = null, concorrenza = 4 }) {
  checkManifest(manifest);
  if (!manifest.files.length) throw new Error('manifest vuoto');
  const errori = [];
  const h = await leggi('/api/health').catch(e => ({ status: 0, body: Buffer.from(e.message) }));
  let health = null; try { health = JSON.parse(h.body.toString('utf8')); } catch { /* sotto */ }
  if (h.status !== 200 || health?.status !== 'ok' || health?.revision !== commit) errori.push(`health: HTTP ${h.status}, revisione ${health?.revision ?? '?'}`);
  for (const p of pagine) {
    const r = await leggi(p).catch(() => ({ status: 0 }));
    if (r.status !== 200) errori.push(`pagina ${p}: HTTP ${r.status}`);
  }
  if (immagineDiProva) {
    const r = await leggi(`/_next/image?url=${encodeURIComponent(immagineDiProva)}&w=64&q=75`).catch(() => ({ status: 0, body: Buffer.alloc(0) }));
    if (r.status !== 200 || !r.body?.length) errori.push(`ottimizzatore immagini: HTTP ${r.status}`);
  }
  let i = 0, verificati = 0;
  const lavora = async () => {
    while (i < manifest.files.length) {
      const f = manifest.files[i++];
      const path = '/_next/static/' + f.path.slice('/_next/static/'.length).split('/').map(encodeURIComponent).join('/');
      try {
        const r = await leggi(path);
        const sha = createHash('sha256').update(r.body).digest('hex');
        if (r.status !== 200) errori.push(`asset ${f.path}: HTTP ${r.status}`);
        else if (r.body.length !== f.size || sha !== f.sha256) errori.push(`asset ${f.path}: contenuto diverso`);
        else verificati++;
      } catch (e) { errori.push(`asset ${f.path}: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: concorrenza }, lavora));
  return { ok: errori.length === 0, verificati, totali: manifest.files.length, errori };
}

async function main(argv) {
  const opt = Object.fromEntries(argv.map(x => { const [k, ...v] = x.replace(/^--/, '').split('='); return [k, v.join('=')]; }));
  const manifest = JSON.parse(await readFile(opt.manifest, 'utf8'));
  let leggi;
  if (opt.vercel) {
    const u = new URL(opt.vercel);
    if (u.protocol !== 'https:' || !u.hostname.endsWith('.vercel.app')) throw new Error('URL del deployment non valido');
    if (!process.env.VERCEL_AUTOMATION_BYPASS_SECRET) throw new Error('manca VERCEL_AUTOMATION_BYPASS_SECRET');
    leggi = lettoreHttp(u.origin, { bypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET });
  } else leggi = lettoreHttp(opt.base);
  const r = await precheck({ leggi, manifest, commit: opt.commit, pagine: (opt.pagine || '/').split(/\s+/).filter(Boolean), immagineDiProva: opt.immagine || null });
  console.log(`pre-check ${opt.vercel ? 'Vercel' : 'container'}: ${r.verificati}/${r.totali} asset identici`);
  for (const e of r.errori.slice(0, 20)) console.log(`FAIL ${e}`);
  if (!r.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(e => { console.error(`pre-check: ${e.message}`); process.exitCode = 1; });
}
