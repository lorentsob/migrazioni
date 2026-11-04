import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collaudo } from '../regia/fasi/collaudo.mjs';
import { validaScheda } from '../regia/lib/scheda.mjs';
import { nuovoStato, apriFase } from '../regia/lib/stato.mjs';
import { serviziFinti, SCHEDA, CONFIG, ENV } from './fixtures/servizi-finti.mjs';

const scheda = validaScheda({ ...SCHEDA, fase: 'collaudo' }, CONFIG);
const T = 'c'.repeat(40);
const ALBERO = ['healthcheck.cjs', 'src/app/api/health/route.ts', 'next.config.mjs', '.github/workflows/rilascio-unico.yml', 'vercel.json', 'package.json'];
const FILE = { 'next.config.mjs': 'output: "standalone"; SOURCE_COMMIT', 'vercel.json': '{"git":{"deploymentEnabled":{"main":false}}}' };
function pronto(mondo = {}) {
  const s = serviziFinti({ rami: { 'lorentsob/esempio': { main: 'a'.repeat(40), 'collaudo/rilascio-unico': T } }, alberi: { [T]: ALBERO }, file: { ...FILE }, ...mondo });
  s.mondo.alSalva = (p, o, m) => { if (p === 'vps/registro.json') for (const v of o.verifiche || []) m.remoto[`vps/esiti/${v.id}.json`] = { id: v.id, esito: m.esitoCert || 'PASS', dettagli: 'Verify return code: 0 (ok)' }; };
  const stato = nuovoStato('esempio'); stato.fasi.prepara = { esito: 'PASS' }; stato.valori.coolifyAppUuid = 'nuovouuid0000000000000000';
  apriFase(stato, 'collaudo', { run: '2', ora: s.ora() });
  return { s, stato, fase: stato.fasi.collaudo };
}
// Il lancio del workflow "produce" un run completato e il registro di collaudo.
const lancioOk = m => { m.runs = [{ id: 9, sha: T, stato: 'completed', esito: 'success', url: 'u' }]; m.file['release.json'] = JSON.stringify({ commit: T, esito: 'completo', runId: '9' }); };

test('collaudo completo: prerequisiti, rilascio lanciato sul ramo, verifica-sito, certificato dall\'agente, attesa "ok collaudo"', async () => {
  const { s, stato, fase } = pronto({ alLancio: lancioOk });
  const m = await collaudo(scheda, s, { env: ENV, config: CONFIG, stato, fase });
  const n = s.chiamate.map(c => c[0]);
  assert.deepEqual(s.chiamate.find(c => c[0] === 'gh.lanciaWorkflow').slice(1), ['rilascio-unico.yml', 'collaudo/rilascio-unico']);
  const ver = s.mondo.esecuzioni.find(e => e[0] === 'bash'); assert.ok(ver[1].endsWith('verifica-sito.sh')); assert.deepEqual(ver.slice(2), ['collaudo-esempio.lorentso.it', 'esempio-collaudo-lorentsob.vercel.app', T]);
  assert.ok(n.includes('regia.attendi')); assert.ok(n.includes('vercel.bypass'), 'bypass del progetto per verifica-sito');
  assert.deepEqual(s.mondo.regiaFile['vps/registro.json'].verifiche, [], 'la richiesta di verifica viene tolta dopo la lettura');
  assert.equal(fase.attesa, 'ok collaudo'); assert.equal(stato.valori.commitCollaudo, T);
  assert.match(m, /collaudo PASS/); assert.match(m, /https:\/\/collaudo-esempio\.lorentso\.it/);
});
test('rilascio già fatto per la testa del ramo: nessun nuovo lancio', async () => {
  const { s, stato, fase } = pronto({ file: { ...FILE, 'release.json': JSON.stringify({ commit: T, esito: 'completo', runId: '8' }) } });
  await collaudo(scheda, s, { env: ENV, config: CONFIG, stato, fase });
  assert.ok(!s.chiamate.some(c => c[0] === 'gh.lanciaWorkflow'));
});
test('registro di collaudo fermo: il ramo rilasci-collaudo viene cancellato e si rilascia di nuovo', async () => {
  const { s, stato, fase } = pronto({ file: { ...FILE, 'release.json': JSON.stringify({ commit: 'd'.repeat(40), esito: 'fermo', motivo: 'passo 6' }) }, alLancio: lancioOk });
  await collaudo(scheda, s, { env: ENV, config: CONFIG, stato, fase });
  const n = s.chiamate.map(c => c[0]);
  assert.ok(n.indexOf('gh.cancellaRamo') < n.indexOf('gh.lanciaWorkflow'));
});
test('prerequisiti del codice mancanti: stop con l\'elenco, nessun lancio', async () => {
  const { s, stato, fase } = pronto({ alberi: { [T]: ALBERO.filter(p => p !== 'healthcheck.cjs') } });
  await assert.rejects(collaudo(scheda, s, { env: ENV, config: CONFIG, stato, fase }), /prerequisiti del codice mancanti.*healthcheck\.cjs/);
  assert.ok(!s.chiamate.some(c => c[0] === 'gh.lanciaWorkflow'));
});
test('rilascio di collaudo fallito o verifica-sito fallita o certificato non ok: stop con il motivo', async () => {
  let c = pronto({ alLancio: m => { m.runs = [{ id: 9, sha: T, stato: 'completed', esito: 'failure', url: 'https://run/9' }]; } });
  await assert.rejects(collaudo(scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase }), /rilascio di collaudo failure: https:\/\/run\/9 \(fermo prima della promozione/);
  c = pronto({ alLancio: lancioOk, esitoEsegui: { status: 1, stdout: 'FAIL pagina /en 500\nESITO FAIL\n' } });
  await assert.rejects(collaudo(scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase }), /verifica-sito\.sh fallita.*FAIL pagina \/en 500/);
  c = pronto({ alLancio: lancioOk, esitoCert: 'FAIL' });
  await assert.rejects(collaudo(scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase }), /certificato dall'origine/);
  assert.notEqual(c.fase.attesa, 'ok collaudo');
});
test('rilascio già in corso sul ramo (push): si aspetta la fine e, se completo per la testa, nessun nuovo lancio né cancellazione', async () => {
  let giri = 0;
  const { s, stato, fase } = pronto({ runs: [{ id: 7, sha: T, stato: 'in_progress', esito: null, url: 'u' }], file: { ...FILE, 'release.json': JSON.stringify({ commit: T, esito: 'in corso' }) } });
  s.sleep = async () => { if (++giri === 2) { s.mondo.runs = [{ id: 7, sha: T, stato: 'completed', esito: 'success', url: 'u' }]; s.mondo.file['release.json'] = JSON.stringify({ commit: T, esito: 'completo', runId: '7' }); } };
  await collaudo(scheda, s, { env: ENV, config: CONFIG, stato, fase });
  const n = s.chiamate.map(c => c[0]);
  assert.ok(!n.includes('gh.cancellaRamo')); assert.ok(!n.includes('gh.lanciaWorkflow'));
  assert.equal(fase.attesa, 'ok collaudo'); assert.equal(stato.valori.runCollaudo, '7');
});
