import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { migra, FASI } from '../regia/migra.mjs';
import { serviziFinti, SCHEDA, CONFIG, ENV } from './fixtures/servizi-finti.mjs';

const esegui = (scheda, mondo = {}, fasi = {}) => {
  const s = serviziFinti(mondo);
  return { s, r: migra('siti/esempio.json', { env: ENV, config: CONFIG, s, testo: JSON.stringify(scheda) }) };
};

test('fase "nessuna": nessuna azione e nessuno stato scritto', async () => {
  const { s, r } = esegui({ ...SCHEDA, fase: 'nessuna' });
  assert.equal((await r).esito, 'NIENTE'); assert.equal(s.chiamate.filter(c => c[0] === 'regia.salva').length, 0);
});
test('cutover sospeso in attesa dell\'ok di Lorenzo: esito ATTESA, failover bloccato, avviso "in attesa"', async () => {
  const { FASI: F } = await import('../regia/migra.mjs');
  const orig = F.cutover;
  F.cutover = async (sch, s, { fase }) => { fase.sospesa = true; fase.attesa = 'ok cutover DNS'; return 'preparazione PASS'; };
  try {
    const { s, r } = esegui({ ...SCHEDA, fase: 'cutover' }, { regiaFile: { 'stato/esempio.json': { schema: 'stato/v1', sito: 'esempio', fasi: { prepara: { esito: 'PASS' }, collaudo: { esito: 'PASS' } }, valori: {} } } });
    const e = await r; assert.equal(e.esito, 'ATTESA');
    const st = s.mondo.regiaFile['stato/esempio.json'];
    assert.equal(st.fasi.cutover.esito, 'ATTESA'); assert.equal(st.fasi.cutover.attesa, 'ok cutover DNS'); assert.equal(st.fasi.cutover.sospesa, undefined);
    assert.match(s.mondo.avvisi[0], /^MIGRAZIONE in attesa:/);
    const f = esegui({ ...SCHEDA, fase: 'failover' }, { regiaFile: { 'stato/esempio.json': st } });
    assert.match((await f.r).messaggio, /richiede cutover PASS \(ora: ATTESA\)/);
  } finally { F.cutover = orig; }
});
test('collaudo senza prepara PASS: FAIL con avviso, stato non toccato', async () => {
  const { s, r } = esegui({ ...SCHEDA, fase: 'collaudo' });
  const e = await r; assert.equal(e.esito, 'FAIL'); assert.match(e.messaggio, /richiede prepara PASS/);
  assert.equal(s.mondo.avvisi.length, 1); assert.equal(s.chiamate.filter(c => c[0] === 'regia.salva').length, 0);
});
test('fase che fallisce: stato/<sito>.json con esito FAIL ed errore, due salvataggi (in corso, poi FAIL), avviso STOP', async () => {
  const { s, r } = esegui({ ...SCHEDA, fase: 'prepara' }, { repoAssente: true });
  const e = await r; assert.equal(e.esito, 'FAIL');
  const st = s.mondo.regiaFile['stato/esempio.json'];
  assert.equal(st.fasi.prepara.esito, 'FAIL'); assert.match(st.fasi.prepara.errore, /HTTP 404/); assert.equal(st.fasi.prepara.run, '77');
  assert.deepEqual(s.chiamate.filter(c => c[0] === 'regia.salva').map(c => c[2]), ['stato: esempio prepara in corso', 'stato: esempio prepara FAIL']);
  assert.match(s.mondo.avvisi[0], /^STOP migrazione prepara FAIL/);
});
test('rieseguire prepara azzera le fasi successive nello stato', async () => {
  const { s, r } = esegui({ ...SCHEDA, fase: 'prepara' }, { repoAssente: true, regiaFile: { 'stato/esempio.json': { schema: 'stato/v1', sito: 'esempio', fasi: { prepara: { esito: 'PASS' }, collaudo: { esito: 'PASS' } }, valori: { x: 1 } } } });
  await r; assert.equal(s.mondo.regiaFile['stato/esempio.json'].fasi.collaudo, undefined);
});
test('tutte le fasi sono implementate, nell\'ordine dello stato', () => assert.deepEqual(Object.keys(FASI), ['prepara', 'collaudo', 'cutover', 'failover', 'chiudi']));
test('migra.yml: parte solo da siti/**, una migrazione alla volta, nessun [skip ci], scrive solo stato e vps', async () => {
  const y = await readFile(new URL('../.github/workflows/migra.yml', import.meta.url), 'utf8');
  assert.match(y, /paths: \['siti\/\*\*'\]/); assert.match(y, /group: migrazioni/); assert.match(y, /cancel-in-progress: false/);
  assert.doesNotMatch(y, /skip ci/); assert.match(y, /git add stato vps/); assert.match(y, /node regia\/migra\.mjs "\$SCHEDA"/);
  for (const s of ['MIGRAZIONI_GH_TOKEN', 'VERCEL_TOKEN', 'COOLIFY_TOKEN', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET', 'CLOUDFLARE_WORKERS_TOKEN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) assert.match(y, new RegExp(`secrets\\.${s} `));
});
