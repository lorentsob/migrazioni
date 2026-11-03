import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuraWorkflow, vercelJson, fileDelSito, MODELLI, PREREQUISITI_CODICE } from '../regia/lib/modelli.mjs';
import { validaScheda } from '../regia/lib/scheda.mjs';
import { SCHEDA, CONFIG } from './fixtures/servizi-finti.mjs';

const scheda = validaScheda({ ...SCHEDA, rilascio: { pagine: '/it /en', node: '22.18.0', contestoExtra: '' } }, CONFIG);

test('il blocco CONFIGURAZIONE DEL SITO dei due workflow prende i valori della scheda, identici', async () => {
  const u = configuraWorkflow(await readFile(join(MODELLI, 'rilascio-unico.yml'), 'utf8'), scheda);
  const sb = configuraWorkflow(await readFile(join(MODELLI, 'rilascio-sblocca.yml'), 'utf8'), scheda);
  for (const t of [u, sb]) {
    assert.match(t, /^  SITO: esempio\.it$/m); assert.match(t, /^  BACKUP_DOMINIO: backup\.esempio\.it$/m);
    assert.match(t, /^  VERCEL_PROJECT_ID: prj_abc123$/m); assert.match(t, /^  VERCEL_ORG_ID: team_x$/m); assert.match(t, /^  NODE_VERSION: 22\.18\.0$/m);
    assert.doesNotMatch(t, /lacisterna/);
  }
  assert.match(u, /^  IMMAGINE: ghcr\.io\/lorentsob\/esempio$/m); assert.match(u, /^  PAGINE: "\/it \/en"$/m); assert.match(u, /^  CONTESTO_EXTRA: ""$/m);
  const blocco = t => t.split('\n').filter(l => /^  [A-Z_]+: /.test(l) && !/COOLIFY_APP_UUID|PAGINE|IMMAGINE|CONTESTO|VERCEL_CLI|WRANGLER|RAMO_REGISTRO|TELEMETRY/.test(l));
  assert.deepEqual(blocco(u), blocco(sb));
  assert.match(u, /COOLIFY_APP_UUID: \$\{\{ vars\.COOLIFY_APP_UUID \}\}/);
});
test('vercel.json: creato da zero o unito a quello esistente, con main e ramo di collaudo spenti', () => {
  assert.deepEqual(JSON.parse(vercelJson(null, scheda)), { git: { deploymentEnabled: { main: false, 'collaudo/rilascio-unico': false } } });
  const unito = JSON.parse(vercelJson('{"headers":[{"source":"/x"}],"git":{"deploymentEnabled":{"dev":true}}}', scheda));
  assert.deepEqual(unito.headers, [{ source: '/x' }]);
  assert.deepEqual(unito.git.deploymentEnabled, { dev: true, main: false, 'collaudo/rilascio-unico': false });
  assert.throws(() => vercelJson('{non json', scheda), /non è JSON/);
});
test('fileDelSito: i 15 file del README dei modelli, Worker con il nome del sito', async () => {
  const f = await fileDelSito(scheda, { vercelEsistente: null });
  const percorsi = f.map(x => x.percorso);
  assert.equal(f.length, 15);
  for (const p of ['.github/workflows/rilascio-unico.yml', '.github/workflows/rilascio-sblocca.yml', '.github/rilascio/Dockerfile.prebuilt', '.github/rilascio/asset.mjs',
    '.github/rilascio/precheck.mjs', '.github/rilascio/promuovi.mjs', '.github/rilascio/adattatori.mjs', '.github/rilascio/generate-failover-allowlist-config.mjs',
    '.github/rilascio/verifica-sito.sh', '.github/rilascio/verifica_sito.py', '.github/rilascio/worker/failover-worker.mjs', '.github/rilascio/worker/worker-sito.mjs',
    '.github/rilascio/worker/siti/esempio.mjs', '.github/rilascio/worker/wrangler.jsonc', 'vercel.json']) assert.ok(percorsi.includes(p), p);
  const w = f.find(x => x.percorso.endsWith('worker-sito.mjs')).contenuto;
  assert.match(w, /import \{ esempio \} from '\.\/siti\/esempio\.mjs'/); assert.match(w, /SOSTITUIRE_CON_COMMIT_COMPLETO/);
  assert.match(f.find(x => x.percorso.endsWith('wrangler.jsonc')).contenuto, /"name": "esempio-failover"/);
  assert.match(f.find(x => x.percorso.endsWith('siti/esempio.mjs')).contenuto, /publicHosts: \["esempio\.it","www\.esempio\.it"\]/);
  assert.doesNotMatch(f.find(x => x.percorso.endsWith('coolify')) ? 'x' : '', /coolify-risorsa/);
});
test('prerequisiti del codice: riconoscono standalone, health, healthcheck, vercel.json', async () => {
  const file = { 'next.config.mjs': 'export default { output: "standalone", env: { SOURCE_COMMIT: process.env.SOURCE_COMMIT || "" } }', 'vercel.json': '{"git":{"deploymentEnabled":{"main":false}}}' };
  const albero = new Set(['healthcheck.cjs', 'src/app/api/health/route.ts', 'next.config.mjs', '.github/workflows/rilascio-unico.yml', 'vercel.json']);
  const leggi = async p => file[p] ?? null;
  for (const p of PREREQUISITI_CODICE) assert.equal(await p.verifica(albero, leggi), true, p.nome);
  const senza = new Set([...albero].filter(p => p !== 'healthcheck.cjs' && !p.includes('health/route')));
  const esiti = await Promise.all(PREREQUISITI_CODICE.map(p => p.verifica(senza, leggi)));
  assert.deepEqual(esiti.map(Boolean), [false, false, true, true, true, true]);
});
