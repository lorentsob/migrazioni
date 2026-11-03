import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepara, SEGRETI_SITO } from '../regia/fasi/prepara.mjs';
import { validaScheda } from '../regia/lib/scheda.mjs';
import { nuovoStato, apriFase } from '../regia/lib/stato.mjs';
import { serviziFinti, SCHEDA, CONFIG, ENV } from './fixtures/servizi-finti.mjs';

const scheda = validaScheda(SCHEDA, CONFIG);
const U = 'nuovouuid0000000000000000';
function pronto(mondo = {}) {
  const s = serviziFinti(mondo);
  // L'agente VPS "risponde" appena la regia salva il registro.
  s.mondo.alSalva = (p, o, m) => { if (p === 'vps/registro.json' && !m.agenteMuto) for (const r of o.risorse) m.remoto[`vps/esiti/${r.uuid}.json`] = { uuid: r.uuid, voluto: r.voluto, esito: m.esitoAgente || 'PASS', applicato: 'x' }; };
  const stato = nuovoStato('esempio'); apriFase(stato, 'prepara', { run: '1', ora: s.ora() });
  return { s, stato, fase: stato.fasi.prepara };
}

test('prepara da zero: DNS, bypass, secret, variabili, risorsa Coolify, registro VPS, ramo con modelli, PR', async () => {
  const { s, stato, fase } = pronto();
  const m = await prepara(scheda, s, { env: ENV, config: CONFIG, stato, fase });
  const n = s.chiamate.map(c => c[0]);
  assert.ok(n.includes('cf.creaA'), 'record DNS creato');
  assert.deepEqual(s.chiamate.find(c => c[0] === 'cf.creaA').slice(1), ['collaudo-esempio.lorentso.it', '10.0.0.1']);
  assert.ok(s.mondo.segreti.includes('VERCEL_AUTOMATION_BYPASS_SECRET'));
  for (const x of SEGRETI_SITO) assert.ok(s.mondo.segreti.includes(x), x);
  assert.equal(s.mondo.variabili.DOMINIO_COLLAUDO, 'collaudo-esempio.lorentso.it');
  assert.equal(s.mondo.variabili.VERCEL_ALIAS_TEST, 'esempio-collaudo-lorentsob.vercel.app');
  assert.equal(s.mondo.variabili.COOLIFY_APP_UUID, U);
  assert.equal(s.mondo.variabili.CLOUDFLARE_ACCOUNT_ID, 'acc1');
  assert.deepEqual(s.chiamate.find(c => c[0] === 'coolify.crea').slice(1), ['esempio-img', 'https://collaudo-esempio.lorentso.it']);
  assert.ok(n.indexOf('coolify.deploy') > n.indexOf('coolify.crea'));
  const reg = s.mondo.regiaFile['vps/registro.json'];
  assert.equal(reg.risorse.length, 1); assert.equal(reg.risorse[0].uuid, U); assert.equal(reg.risorse[0].voluto, 'registrata'); assert.equal(reg.risorse[0].statico, false);
  assert.ok(n.indexOf('regia.attendi') > n.indexOf('regia.salva'));
  const sf = s.chiamate.find(c => c[0] === 'gh.scriviFile'); assert.equal(sf[1], 'collaudo/rilascio-unico'); assert.equal(sf[2].length, 15);
  assert.ok(n.includes('gh.apriPr'));
  assert.equal(stato.valori.coolifyAppUuid, U); assert.equal(stato.valori.pr, 'https://github.com/lorentsob/esempio/pull/5');
  assert.match(m, /prepara PASS/);
  assert.equal(fase.passi.length, 11, JSON.stringify(fase.passi.map(p => p.nome)));
});
test('prepara ripetuta: tutto già presente, nessuna creazione, PR non duplicata', async () => {
  const { s, stato, fase } = pronto({ record: [{ id: 'r', tipo: 'A', contenuto: '10.0.0.1', proxied: true }],
    coolifyApp: [{ uuid: U, name: 'esempio-img', fqdn: 'https://collaudo-esempio.lorentso.it' }],
    vercelProgetto: { name: 'esempio', link: { org: 'lorentsob', repo: 'esempio' }, protectionBypass: { vecchio123: { scope: 'automation-bypass' } } },
    pr: { numero: 3, url: 'https://github.com/lorentsob/esempio/pull/3' }, rami: { 'lorentsob/esempio': { main: 'a'.repeat(40), 'collaudo/rilascio-unico': 'c'.repeat(40) } } });
  await prepara(scheda, s, { env: ENV, config: CONFIG, stato, fase });
  const n = s.chiamate.map(c => c[0]);
  for (const x of ['cf.creaA', 'coolify.crea', 'coolify.deploy', 'gh.apriPr']) assert.ok(!n.includes(x), `${x} non deve essere chiamata`);
  assert.equal(s.chiamate.find(c => c[0] === 'gh.segreto' && c[1] === 'VERCEL_AUTOMATION_BYPASS_SECRET')[2], 'valore');
  assert.equal(stato.valori.pr, 'https://github.com/lorentsob/esempio/pull/3');
  assert.match(fase.passi.find(p => p.nome === 'bypass Vercel').esito, /riusato/);
});
test('stop senza scritture: progetto Vercel di un altro repo, record DNS diverso, risorsa omonima con altri domini', async () => {
  let c = pronto({ vercelProgetto: { name: 'x', link: { org: 'altro', repo: 'cosa' }, protectionBypass: {} } });
  await assert.rejects(prepara(scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase }), /collegato a altro\/cosa/);
  assert.ok(!c.s.chiamate.some(x => /creaA|segreto|crea|salva/.test(x[0])));
  c = pronto({ record: [{ id: 'r', tipo: 'CNAME', contenuto: 'altro.it', proxied: true }] });
  await assert.rejects(prepara(scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase }), /già presente ma diverso/);
  c = pronto({ coolifyApp: [{ uuid: 'altro000000000000000000000', name: 'esempio-img', fqdn: 'https://esempio.it' }] });
  await assert.rejects(prepara(scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase }), /esiste già una risorsa/);
  assert.ok(!c.s.chiamate.some(x => x[0] === 'coolify.crea'));
});
test('agente VPS muto o in errore: la fase si ferma prima del ramo e della PR', async () => {
  let c = pronto({ agenteMuto: true });
  await assert.rejects(prepara(scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase }), /agente VPS non ha risposto/);
  assert.ok(!c.s.chiamate.some(x => x[0] === 'gh.scriviFile'));
  c = pronto({ esitoAgente: 'FAIL' });
  await assert.rejects(prepara(scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase }), /registrazione sulla VPS fallita/);
});
test('segreto mancante nella regia: stop con il nome', async () => {
  const c = pronto();
  await assert.rejects(prepara(scheda, c.s, { env: { ...ENV, COOLIFY_TOKEN: '' }, config: CONFIG, stato: c.stato, fase: c.fase }), /segreto COOLIFY_TOKEN: valore vuoto/);
});
test('sito statico: la voce del registro porta statico=true; variabili Preview mancanti segnalate come avviso', async () => {
  const c = pronto({ vercelEnv: { production: ['A', 'KV_URL', 'VERCEL_X'], preview: ['A'] } });
  await prepara({ ...scheda, statico: true }, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase });
  assert.equal(c.s.mondo.regiaFile['vps/registro.json'].risorse[0].statico, true);
  assert.deepEqual(c.stato.valori.variabiliPreviewMancanti, ['KV_URL']);
  assert.match(c.fase.passi.find(p => p.nome === 'variabili Vercel in Preview').esito, /AVVISO mancano in Preview: KV_URL/);
});
