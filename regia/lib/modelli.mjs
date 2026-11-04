// Genera i file del rilascio unico per il repository di un sito, a partire da modelli/
// (copia di vps-oracle/coolify/templates) e dalla scheda. Nessuna rete: solo file.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const QUI = dirname(fileURLToPath(import.meta.url));
export const MODELLI = join(QUI, '..', '..', 'modelli');

const CHIAVI = ['SITO', 'DOMINIO', 'BACKUP_DOMINIO', 'IMMAGINE', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID', 'PAGINE', 'IMMAGINE_DI_PROVA', 'CONTESTO_EXTRA', 'NODE_VERSION'];

/** Sostituisce i valori del blocco "CONFIGURAZIONE DEL SITO" in un workflow modello. */
export function configuraWorkflow(testo, scheda) {
  const valori = {
    SITO: scheda.dominio, DOMINIO: scheda.dominio, BACKUP_DOMINIO: scheda.backupDominio, IMMAGINE: scheda.rilascio.immagine,
    VERCEL_ORG_ID: scheda.vercel.team, VERCEL_PROJECT_ID: scheda.vercel.progetto, PAGINE: scheda.rilascio.pagine,
    IMMAGINE_DI_PROVA: scheda.rilascio.immagineDiProva ?? '', CONTESTO_EXTRA: scheda.rilascio.contestoExtra, NODE_VERSION: scheda.rilascio.node,
  };
  const righe = testo.split('\n');
  const inizio = righe.findIndex(l => /CONFIGURAZIONE DEL SITO/.test(l));
  const fine = righe.findIndex((l, i) => i > inizio && /fine configurazione/.test(l));
  if (inizio < 0 || fine < 0) throw new Error('modello senza blocco CONFIGURAZIONE DEL SITO');
  for (let i = inizio + 1; i < fine; i++) {
    const m = righe[i].match(/^(\s+)([A-Z_]+):\s*(.*)$/);
    if (!m || !CHIAVI.includes(m[2])) continue;
    const v = valori[m[2]];
    if (v == null) continue;
    righe[i] = `${m[1]}${m[2]}: ${/^[A-Za-z0-9.\/_:@-]+$/.test(v) && v !== '' ? v : JSON.stringify(v)}`;
  }
  return righe.join('\n');
}

/** vercel.json del sito: spegne i deploy da git di main e del ramo di collaudo, conserva il resto. */
export function vercelJson(esistente, scheda) {
  let j = {};
  if (esistente) { try { j = JSON.parse(esistente); } catch { throw new Error('vercel.json esistente non è JSON valido'); } }
  const git = { ...(j.git || {}) };
  const de = typeof git.deploymentEnabled === 'object' && git.deploymentEnabled ? { ...git.deploymentEnabled } : {};
  de[scheda.ramo] = false; de[scheda.ramoCodice] = false;
  return `${JSON.stringify({ ...j, git: { ...git, deploymentEnabled: de } }, null, 2)}\n`;
}

export function workerSito(scheda) {
  const nome = scheda.sito.replace(/-/g, '_');
  return `// Punto di ingresso del Worker di failover per ${scheda.dominio} (generato dalla regia).
// A ogni release la pipeline scrive allowlist.json accanto a questo file e sostituisce
// revisione e hash attesi; il Worker rifiuta una lista di un'altra release.
import { createHandler, standbyAssetsFrom } from './failover-worker.mjs';
import { ${nome} } from './siti/${scheda.sito}.mjs';
import allowlist from './allowlist.json' with { type: 'json' };

const RELEASE = Object.freeze({
  revision: 'SOSTITUIRE_CON_COMMIT_COMPLETO',
  manifestSha256: 'SOSTITUIRE_CON_HASH_MANIFEST',
});

export const config = Object.freeze({ ...${nome}, standbyAssets: standbyAssetsFrom(allowlist, RELEASE) });
export default { fetch: createHandler(config) };
`;
}

export function configurazioneWorkerSito(scheda) {
  const nome = scheda.sito.replace(/-/g, '_');
  const hosts = [scheda.dominio, ...(scheda.www ? [`www.${scheda.dominio}`] : [])];
  return `// Configurazione del Worker di failover per ${scheda.dominio}. BOZZA generata dalla regia:
// le pagine pubbliche, i file esatti e i cookie tecnici vanno adattati al sito in C7
// (vedi siti/lacisterna.mjs nei modelli come esempio completo).
export const ${nome} = Object.freeze({
  publicHosts: ${JSON.stringify(hosts)},
  standbyHost: '${scheda.backupDominio}',
  timeoutMs: 5000,
  circuitMs: 60000,
  localeCookie: { name: 'NEXT_LOCALE', values: ['it', 'en'] },
  publicPathPatterns: [
    /^\\/$/,
    /^\\/(?:it|en)(?:\\/[A-Za-z0-9_-]+){0,2}\\/?$/,
  ],
  publicExactPaths: ['/favicon.ico', '/robots.txt', '/sitemap.xml'],
  excludedPrefixes: ['/api', '/preview', '/slice-simulator', '/.well-known/acme-challenge'],
  technicalCookiePatterns: [],
});
`;
}

export function wranglerJsonc(scheda) {
  return `// Worker di failover di ${scheda.dominio}. Nessuna route qui: restano quelle su Cloudflare (fail open).
{
  "name": "${scheda.worker.nome}",
  "main": "worker-sito.mjs",
  "compatibility_date": "2026-10-27",
  "workers_dev": false,
  "preview_urls": false
}
`;
}

/**
 * Elenco {percorso, contenuto} dei file da scrivere nel repository del sito.
 * vercelEsistente: contenuto attuale di vercel.json (o null).
 */
export async function fileDelSito(scheda, { vercelEsistente = null, leggi = p => readFile(join(MODELLI, p), 'utf8') } = {}) {
  const copia = async (da, a) => ({ percorso: a, contenuto: await leggi(da) });
  const file = [
    { percorso: '.github/workflows/rilascio-unico.yml', contenuto: configuraWorkflow(await leggi('rilascio-unico.yml'), scheda) },
    { percorso: '.github/workflows/rilascio-sblocca.yml', contenuto: configuraWorkflow(await leggi('rilascio-sblocca.yml'), scheda) },
    await copia('Dockerfile.prebuilt', '.github/rilascio/Dockerfile.prebuilt'),
    await copia('rilascio/asset.mjs', '.github/rilascio/asset.mjs'),
    await copia('rilascio/precheck.mjs', '.github/rilascio/precheck.mjs'),
    await copia('rilascio/promuovi.mjs', '.github/rilascio/promuovi.mjs'),
    await copia('rilascio/adattatori.mjs', '.github/rilascio/adattatori.mjs'),
    await copia('generate-failover-allowlist-config.mjs', '.github/rilascio/generate-failover-allowlist-config.mjs'),
    await copia('verifica-sito.sh', '.github/rilascio/verifica-sito.sh'),
    await copia('verifica_sito.py', '.github/rilascio/verifica_sito.py'),
    await copia('worker/failover-worker.mjs', '.github/rilascio/worker/failover-worker.mjs'),
    { percorso: '.github/rilascio/worker/worker-sito.mjs', contenuto: workerSito(scheda) },
    { percorso: `.github/rilascio/worker/siti/${scheda.sito}.mjs`, contenuto: configurazioneWorkerSito(scheda) },
    { percorso: '.github/rilascio/worker/wrangler.jsonc', contenuto: wranglerJsonc(scheda) },
    { percorso: 'vercel.json', contenuto: vercelJson(vercelEsistente, scheda) },
  ];
  return file;
}

/** Prerequisiti del codice (C2) che la regia controlla prima del collaudo: {nome, verifica(filePresenti, leggi)}. */
export const PREREQUISITI_CODICE = [
  { nome: 'healthcheck.cjs nella radice', verifica: f => f.has('healthcheck.cjs') },
  { nome: 'route /api/health (app/api/health/route.* o src/app/api/health/route.* o pages/api/health.*)',
    verifica: f => [...f].some(p => /^(src\/)?(app\/api\/health\/route\.[cm]?[jt]sx?|pages\/api\/health\.[cm]?[jt]sx?)$/.test(p)) },
  { nome: 'output: "standalone" in next.config.*', verifica: async (f, leggi) => {
      for (const p of [...f].filter(p => /^next\.config\.[cm]?[jt]s$/.test(p))) if (/output:\s*['"]standalone['"]/.test(await leggi(p))) return true; return false; } },
  { nome: 'SOURCE_COMMIT in next.config.* (env)', verifica: async (f, leggi) => {
      for (const p of [...f].filter(p => /^next\.config\.[cm]?[jt]s$/.test(p))) if (/SOURCE_COMMIT/.test(await leggi(p))) return true; return false; } },
  { nome: 'workflow rilascio-unico.yml', verifica: f => f.has('.github/workflows/rilascio-unico.yml') },
  { nome: 'vercel.json con i deploy da git spenti', verifica: async (f, leggi) => {
      if (!f.has('vercel.json')) return false; try { const j = JSON.parse(await leggi('vercel.json')); return j?.git?.deploymentEnabled?.main === false; } catch { return false; } } },
];
