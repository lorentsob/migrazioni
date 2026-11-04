import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failover } from '../regia/fasi/failover.mjs';
import { chiudi } from '../regia/fasi/chiudi.mjs';
import { validaScheda } from '../regia/lib/scheda.mjs';
import { nuovoStato, apriFase } from '../regia/lib/stato.mjs';
import { serviziFinti, SCHEDA, CONFIG, ENV } from './fixtures/servizi-finti.mjs';

const M = 'd'.repeat(40), UUID = 'nuovouuid0000000000000000';
const FILE_WORKER = { '.github/rilascio/worker/worker-sito.mjs': 'x', '.github/rilascio/worker/siti/esempio.mjs': 'x', '.github/rilascio/worker/wrangler.jsonc': 'x' };

function base(fase, mondo = {}) {
  const scheda = validaScheda({ ...SCHEDA, fase }, CONFIG);
  const s = serviziFinti({ dns: [], variabili: {}, file: { ...FILE_WORKER, 'release.json': JSON.stringify({ commit: M, esito: 'completo', runId: '20' }) },
    alLancio: m => { m.runs = [{ id: 20 + m.runs.length, sha: M, stato: 'completed', esito: 'success', url: 'r' }, ...m.runs]; }, ...mondo });
  const stato = nuovoStato('esempio');
  for (const f of ['prepara', 'collaudo', 'cutover']) stato.fasi[f] = { esito: 'PASS' };
  Object.assign(stato.valori, { coolifyAppUuid: UUID, ramoCodice: 'collaudo/rilascio-unico', aliasCollaudo: 'esempio-collaudo-lorentsob.vercel.app', cutover: { dns: '2026-11-03T09:00:00Z', commit: M } });
  apriFase(stato, fase, { run: '5', ora: s.ora() });
  return { scheda, s, stato, fase: stato.fasi[fase] };
}

test('failover: WORKER_FAILOVER attivo, rilascio che pubblica il Worker, route sui nomi del sito, prova con la pausa servita dal backup', async () => {
  const c = base('failover');
  // Durante la pausa (esito non ancora scritto) le sonde ricevono la pagina dal backup.
  c.s.mondo.http = (url, o, m) => ({ status: 200, headers: m.inPausa ? { 'x-served-by': 'vercel-hot-standby' } : {}, testo: '' });
  c.s.mondo.alSalva = (p, o, m) => { if (p === 'vps/registro.json') for (const v of o.verifiche || []) { m.inPausa = true; setTimeout(() => { m.remoto[`vps/esiti/${v.id}.json`] = { id: v.id, esito: 'PASS', dettagli: 'container in pausa 120 s, poi ripreso' }; m.inPausa = false; }, 5); } };
  const attendi = c.s.regia.attendi;
  c.s.regia.attendi = async (p, cond) => { for (let i = 0; i < 50; i++) { const e = c.s.mondo.remoto[p]; if (e && cond(e)) return e; await new Promise(r => setTimeout(r, 2)); } return attendi(p, cond); };
  const m = await failover(c.scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase });
  assert.match(m, /failover PASS/);
  assert.equal(c.s.mondo.variabili.WORKER_FAILOVER, 'attivo');
  assert.deepEqual(c.s.mondo.rotte.map(r => [r.schema, r.script]), [['esempio.it/*', 'esempio-failover'], ['www.esempio.it/*', 'esempio-failover']]);
  const reg = c.s.chiamate.filter(x => x[0] === 'regia.salva' && x[1] === 'vps/registro.json');
  assert.ok(reg.length >= 2, 'richiesta di pausa e poi tolta');
  assert.ok(c.stato.valori.failover.prova.backup > 0);
});

test('failover: nessuna risposta dal backup durante la pausa → stop', async () => {
  const c = base('failover');
  c.s.mondo.alSalva = (p, o, m) => { if (p === 'vps/registro.json') for (const v of o.verifiche || []) m.remoto[`vps/esiti/${v.id}.json`] = { id: v.id, esito: 'PASS', dettagli: 'pausa' }; };
  await assert.rejects(failover(c.scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase }), /nessuna risposta dal backup/);
});

test('failover: pagina rotta con il Worker attivo → route tolte (rollback) e stop', async () => {
  const c = base('failover', { http: () => ({ status: 502, headers: {}, testo: '' }) });
  await assert.rejects(failover(c.scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase }), /route del Worker tolte/);
  assert.equal(c.s.mondo.rotte.length, 0);
});

test('chiudi: troppo presto dopo il cutover → stop senza toccare nulla', async () => {
  const c = base('chiudi'); c.stato.valori.cutover.dns = '2026-11-04T09:00:00Z';
  await assert.rejects(chiudi(c.scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase }), /dal giorno dopo/);
  assert.ok(!c.s.chiamate.some(x => /cancella|aggiorna/.test(x[0])));
});

test('chiudi: verifica-sito, certificati, poi pulizia di variabili, rami, nome di collaudo e alias', async () => {
  const c = base('chiudi', { coolifyDettaglio: { fqdn: 'https://collaudo-esempio.lorentso.it,https://esempio.it,https://www.esempio.it' },
    dns: [{ id: 'k1', nome: 'collaudo-esempio.lorentso.it', tipo: 'A', contenuto: '10.0.0.1', proxied: true }], variabili: { DOMINIO_COLLAUDO: 'x', VERCEL_ALIAS_TEST: 'y', WORKER_FAILOVER: 'attivo' } });
  c.s.mondo.alSalva = (p, o, m) => { if (p === 'vps/registro.json') for (const v of o.verifiche || []) m.remoto[`vps/esiti/${v.id}.json`] = { id: v.id, esito: 'PASS', dettagli: 'ok' }; };
  const m = await chiudi(c.scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase });
  assert.match(m, /chiudi PASS/);
  assert.deepEqual(c.s.mondo.variabili, { WORKER_FAILOVER: 'attivo' });
  assert.deepEqual(c.s.chiamate.filter(x => x[0] === 'gh.cancellaRamo').map(x => x[1]), ['collaudo/rilascio-unico', 'rilasci-collaudo']);
  assert.equal(c.s.mondo.coolifyDettaglio.fqdn, 'https://esempio.it,https://www.esempio.it');
  assert.equal(c.s.mondo.dns.length, 0);
  assert.ok(c.s.chiamate.some(x => x[0] === 'vercel.cancellaAlias' && x[1] === 'esempio-collaudo-lorentsob.vercel.app'));
  const ver = c.s.mondo.esecuzioni.find(e => e[0] === 'bash'); assert.deepEqual(ver.slice(2), ['esempio.it', 'backup.esempio.it', M]);
});
