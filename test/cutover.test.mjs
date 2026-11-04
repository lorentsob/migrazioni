import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutover } from '../regia/fasi/cutover.mjs';
import { validaScheda } from '../regia/lib/scheda.mjs';
import { nuovoStato, apriFase } from '../regia/lib/stato.mjs';
import { codiceAcme } from '../regia/lib/acme.mjs';
import { serviziFinti, SCHEDA, CONFIG, ENV } from './fixtures/servizi-finti.mjs';

const T = 'c'.repeat(40), M = 'd'.repeat(40), VPS = CONFIG.vpsIp;
const UUID = 'nuovouuid0000000000000000';
const DNS = () => [
  { id: 'a1', nome: 'esempio.it', tipo: 'A', contenuto: '76.76.21.21', proxied: true, ttl: 1 },
  { id: 'w1', nome: 'www.esempio.it', tipo: 'CNAME', contenuto: 'cname.vercel-dns.com', proxied: true, ttl: 1 },
  { id: 'm1', nome: 'esempio.it', tipo: 'MX', contenuto: 'route1.mx.cloudflare.net', proxied: false, ttl: 1, priorita: 10 },
  { id: 't1', nome: 'esempio.it', tipo: 'TXT', contenuto: 'v=spf1 include:_spf.mx.cloudflare.net ~all', proxied: false, ttl: 1 },
];
const sullaVps = (m, n) => m.dns.some(r => r.nome === n && r.tipo === 'A' && r.contenuto === VPS);
// Il "mondo" HTTP: backup Vercel ok, health della VPS con il commit unito, www reindirizza, webhook 401.
const httpOk = (url, o, m) => {
  if (url.startsWith('https://backup.esempio.it')) return { status: 200, headers: {}, testo: '' };
  if (url === 'https://collaudo-esempio.lorentso.it/api/health') return { status: 200, headers: {}, testo: JSON.stringify({ status: 'ok', revision: m.prDettaglio.unita ? M : T }) };
  if (url === 'https://esempio.it/api/health') return sullaVps(m, 'esempio.it') && !m.vpsRotta ? { status: 200, headers: {}, testo: JSON.stringify({ status: 'ok', revision: M }) } : { status: 404, headers: {}, testo: '' };
  if (url === 'https://www.esempio.it/') return { status: 308, headers: { location: 'https://esempio.it/' }, testo: '' };
  if (url.endsWith('/api/revalidate')) return { status: 401, headers: {}, testo: '' };
  return { status: 200, headers: {}, testo: '' };
};
function pronto({ ok = null, mondo = {} } = {}) {
  const scheda = validaScheda({ ...SCHEDA, fase: 'cutover', variabiliRichieste: ['PRISMIC_WEBHOOK_SECRET'], webhook: '/api/revalidate', ...(ok ? { ok: { cutover: ok } } : {}) }, CONFIG);
  const s = serviziFinti({
    dns: DNS(), prDettaglio: { numero: 5, url: 'https://github.com/lorentsob/esempio/pull/5', aperta: true, bozza: true, unita: false, testa: T, mergeSha: null, messaggi: ['C2', 'pipeline'] },
    mergeSha: M, vercelValori: [{ chiave: 'SITE_URL', valore: 'https://esempio.it', tipo: 'encrypted' }, { chiave: 'PRISMIC_WEBHOOK_SECRET', valore: 'segreto', tipo: 'encrypted' }],
    coolifyEnv: [{ uuid: 'w', chiave: 'WHOAMI_PORT_NUMBER', preview: false }], coolifyDettaglio: { fqdn: 'https://collaudo-esempio.lorentso.it' },
    http: httpOk,
    alMerge: m => { m.runs = [{ id: 11, sha: M, stato: 'completed', esito: 'success', url: 'r11' }]; m.file['release.json'] = JSON.stringify({ commit: M, esito: 'completo', runId: '11' }); },
    alLancio: m => { m.runs = [{ id: 12, sha: M, stato: 'completed', esito: 'success', url: 'r12' }, ...m.runs]; },
    ...mondo,
  });
  s.mondo.alSalva = (p, o, m) => { if (p === 'vps/registro.json') for (const v of o.verifiche || []) m.remoto[`vps/esiti/${v.id}.json`] = { id: v.id, esito: m.esitoCert || 'PASS', dettagli: 'Verify return code: 0 (ok)' }; };
  const stato = nuovoStato('esempio');
  stato.fasi.prepara = { esito: 'PASS' }; stato.fasi.collaudo = { esito: 'PASS', ok: { da: 'Lorenzo' } };
  Object.assign(stato.valori, { coolifyAppUuid: UUID, pr: 'https://github.com/lorentsob/esempio/pull/5', commitCollaudo: T, ramoCodice: 'collaudo/rilascio-unico', aliasCollaudo: 'esempio-collaudo-lorentsob.vercel.app' });
  apriFase(stato, 'cutover', { run: '3', ora: s.ora() });
  return { scheda, s, stato, fase: stato.fasi.cutover };
}
const nomi = s => s.chiamate.map(c => c[0]);

test('senza ok cutover: prepara tutto (export, variabili, backup, ACME, domini, certificati) e si ferma prima del merge e del DNS', async () => {
  const { scheda, s, stato, fase } = pronto();
  const m = await cutover(scheda, s, { env: ENV, config: CONFIG, stato, fase });
  assert.equal(fase.sospesa, true); assert.equal(fase.attesa, 'ok cutover DNS'); assert.match(m, /ok cutover DNS/);
  const exp = s.mondo.regiaFile['stato/zone/esempio-prima-del-cutover.json'];
  assert.equal(exp.record.length, 4, 'export completo salvato');
  assert.deepEqual(s.chiamate.find(c => c[0] === 'coolify.scriviVariabili')[1], ['SITE_URL', 'PRISMIC_WEBHOOK_SECRET']);
  assert.ok(s.chiamate.some(c => c[0] === 'coolify.cancellaVariabile' && c[1] === 'w'), 'WHOAMI_PORT_NUMBER tolta');
  assert.ok(s.chiamate.some(c => c[0] === 'vercel.aggiungiDominio' && c[1] === 'backup.esempio.it'));
  assert.ok(s.mondo.dns.some(r => r.nome === 'backup.esempio.it' && r.tipo === 'CNAME' && !r.proxied), 'backup solo DNS verso Vercel');
  assert.ok(s.mondo.dns.some(r => r.nome === 'origin-vps.esempio.it' && r.contenuto === VPS));
  assert.deepEqual(s.mondo.rotte.map(r => r.schema), ['esempio.it/.well-known/acme-challenge/*', 'www.esempio.it/.well-known/acme-challenge/*']);
  assert.deepEqual(s.chiamate.find(c => c[0] === 'coolify.aggiorna')[2], { domains: 'https://collaudo-esempio.lorentso.it,https://esempio.it,https://www.esempio.it', redirect: 'non-www' });
  assert.ok(nomi(s).indexOf('cf.creaRotta') < nomi(s).indexOf('coolify.aggiorna'), 'ACME pronto prima dei domini');
  assert.equal(Object.keys(s.mondo.remoto).filter(k => k.includes('-cert-')).length, 2, 'certificato per dominio e www');
  for (const n of ['gh.uniscePr', 'gh.prPronta', 'cf.aggiornaRecord', 'gh.lanciaWorkflow']) assert.ok(!nomi(s).includes(n), `${n} non deve partire senza ok`);
  assert.equal(s.mondo.variabili.DOMINIO_OVERRIDE, undefined);
  assert.ok(sullaVps(s.mondo, 'esempio.it') === false);
});

test('con ok cutover: merge con DOMINIO_OVERRIDE, DNS verso la VPS (posta intatta), secondo rilascio, verifica-sito, ACME tolto', async () => {
  const { scheda, s, stato, fase } = pronto({ ok: '2026-11-04 Lorenzo: ok cutover DNS' });
  const m = await cutover(scheda, s, { env: ENV, config: CONFIG, stato, fase });
  assert.equal(fase.sospesa, undefined); assert.match(m, /cutover PASS/);
  const n = nomi(s);
  assert.ok(n.indexOf('gh.prPronta') < n.indexOf('gh.uniscePr'));
  assert.equal(s.chiamate.find(c => c[0] === 'gh.uniscePr')[2], T, 'merge legato alla testa collaudata');
  const ov = s.chiamate.findIndex(c => c[0] === 'gh.variabile' && c[1] === 'DOMINIO_OVERRIDE');
  assert.ok(ov >= 0 && ov < n.indexOf('gh.uniscePr'), 'override prima del merge');
  assert.ok(n.indexOf('gh.uniscePr') < n.indexOf('cf.aggiornaRecord'), 'DNS solo dopo il primo rilascio');
  for (const nome of ['esempio.it', 'www.esempio.it']) {
    const web = s.mondo.dns.filter(r => r.nome === nome && ['A', 'AAAA', 'CNAME'].includes(r.tipo));
    assert.deepEqual(web.map(r => [r.tipo, r.contenuto, r.proxied]), [['A', VPS, true]]);
  }
  assert.ok(s.mondo.dns.some(r => r.tipo === 'MX' && r.contenuto === 'route1.mx.cloudflare.net'), 'MX intatto');
  assert.equal(s.mondo.variabili.DOMINIO_OVERRIDE, undefined, 'override tolta');
  assert.ok(n.indexOf('gh.cancellaVariabile') < n.indexOf('gh.lanciaWorkflow'), 'secondo rilascio dopo aver tolto l\'override');
  const ver = s.mondo.esecuzioni.find(e => e[0] === 'bash'); assert.deepEqual(ver.slice(2), ['esempio.it', 'backup.esempio.it', M]);
  assert.ok(n.includes('cf.cancellaWorker')); assert.equal((s.mondo.rotte || []).length, 0);
  assert.ok(!s.mondo.dns.some(r => r.nome === 'origin-vps.esempio.it'), 'origin-vps tolto');
  assert.equal(stato.valori.cutover.merge, M); assert.ok(stato.valori.cutover.dns);
  assert.ok(fase.passi.some(p => p.nome === 'webhook con secret sbagliato' && /401/.test(p.esito)));
});

test('controllo fallito dopo il cambio DNS: i record web tornano quelli dell\'export (rollback automatico)', async () => {
  const { scheda, s, stato, fase } = pronto({ ok: 'ok', mondo: { vpsRotta: true } });
  await assert.rejects(cutover(scheda, s, { env: ENV, config: CONFIG, stato, fase }), /DNS rimesso su Vercel/);
  const web = n => s.mondo.dns.filter(r => r.nome === n && ['A', 'AAAA', 'CNAME'].includes(r.tipo)).map(r => [r.tipo, r.contenuto, r.proxied]);
  assert.deepEqual(web('esempio.it'), [['A', '76.76.21.21', true]]);
  assert.deepEqual(web('www.esempio.it'), [['CNAME', 'cname.vercel-dns.com', true]]);
  assert.ok(fase.passi.some(p => p.nome === 'ROLLBACK DNS'));
  assert.ok(!s.chiamate.some(c => c[0] === 'gh.lanciaWorkflow'), 'nessun secondo rilascio');
});

test('stop prima di ogni scrittura: PR cambiata dopo il collaudo, [skip ci], variabile richiesta assente, Always Use HTTPS', async () => {
  let c = pronto({ ok: 'ok' }); c.s.mondo.prDettaglio.testa = 'e'.repeat(40);
  await assert.rejects(cutover(c.scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase }), /cambiata dopo il collaudo/);
  c = pronto({ ok: 'ok' }); c.s.mondo.prDettaglio.messaggi.push('fix [skip ci]');
  await assert.rejects(cutover(c.scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase }), /skip ci/);
  c = pronto(); c.s.mondo.vercelValori = c.s.mondo.vercelValori.filter(v => v.chiave !== 'PRISMIC_WEBHOOK_SECRET');
  await assert.rejects(cutover(c.scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase }), /mancano in Vercel \(Production\): PRISMIC_WEBHOOK_SECRET/);
  assert.ok(!nomi(c.s).includes('coolify.scriviVariabili'));
  c = pronto(); c.s.mondo.vercelValori.push({ chiave: 'X', valore: null, tipo: 'sensitive' });
  await assert.rejects(cutover(c.scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase }), /sensitive/);
  c = pronto(); c.s.mondo.impostazioni = { always_use_https: 'on' };
  await assert.rejects(cutover(c.scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase }), /Always Use HTTPS/);
  assert.ok(!nomi(c.s).includes('coolify.aggiorna'));
});

test('certificato dall\'origine non valido: stop senza ok richiesto e senza DNS', async () => {
  const { scheda, s, stato, fase } = pronto({ ok: 'ok', mondo: { esitoCert: 'FAIL' } });
  await assert.rejects(cutover(scheda, s, { env: ENV, config: CONFIG, stato, fase }), /certificato dall'origine per esempio\.it/);
  assert.ok(!nomi(s).includes('gh.uniscePr')); assert.ok(!nomi(s).includes('cf.aggiornaRecord'));
});

test('rilancio dopo il cutover riuscito: nessun nuovo merge né cambio DNS, export originale conservato', async () => {
  const c = pronto({ ok: 'ok' });
  await cutover(c.scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase });
  const exp = c.s.mondo.regiaFile['stato/zone/esempio-prima-del-cutover.json'];
  c.s.chiamate.length = 0; apriFase(c.stato, 'cutover', { run: '4', ora: c.s.ora() });
  await cutover(c.scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.stato.fasi.cutover });
  assert.ok(!nomi(c.s).includes('gh.uniscePr')); assert.ok(!nomi(c.s).includes('cf.aggiornaRecord'));
  assert.deepEqual(c.s.mondo.regiaFile['stato/zone/esempio-prima-del-cutover.json'], exp);
});

test('record web "solo DNS" verso Vercel: messi in proxy prima del Worker ACME (SSL full), rimessi se il sito non risponde', async () => {
  const solo = () => DNS().map(r => ['A', 'CNAME'].includes(r.tipo) ? { ...r, proxied: false } : r);
  let c = pronto({ mondo: { dns: solo(), impostazioni: { ssl: 'strict', always_use_https: 'off' } } });
  await cutover(c.scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase });
  assert.ok(['esempio.it', 'www.esempio.it'].every(n => c.s.mondo.dns.find(r => r.nome === n && ['A', 'CNAME'].includes(r.tipo)).proxied));
  const n = nomi(c.s); assert.ok(n.indexOf('cf.aggiornaRecord') < n.indexOf('cf.creaRotta'));
  c = pronto({ mondo: { dns: solo(), impostazioni: { ssl: 'flexible' } } });
  await assert.rejects(cutover(c.scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase }), /Full o Full \(strict\)/);
  assert.ok(!nomi(c.s).includes('cf.aggiornaRecord'));
  c = pronto({ mondo: { dns: solo(), impostazioni: { ssl: 'full' }, http: (u, o, m) => u === 'https://esempio.it/' ? { status: 525, headers: {}, testo: '' } : httpOk(u, o, m) } });
  await assert.rejects(cutover(c.scheda, c.s, { env: ENV, config: CONFIG, stato: c.stato, fase: c.fase }), /rimessi "solo DNS"/);
  assert.ok(c.s.mondo.dns.filter(r => ['A', 'CNAME'].includes(r.tipo)).every(r => !r.proxied));
});

test('Worker ACME: inoltra solo la sfida HTTP dei nomi del sito verso origin-vps', async () => {
  const scheda = validaScheda({ ...SCHEDA, fase: 'cutover' }, CONFIG);
  const src = codiceAcme(scheda);
  const w = (await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`)).default;
  const orig = globalThis.fetch; let visto = null;
  globalThis.fetch = async (url, o) => { visto = { url, o }; return new Response('prova', { status: 200 }); };
  try {
    for (const h of ['esempio.it', 'www.esempio.it']) {
      const r = await w.fetch(new Request(`http://${h}/.well-known/acme-challenge/abc_DEF-1`));
      assert.equal(r.status, 200); assert.equal(visto.o.cf.resolveOverride, 'origin-vps.esempio.it'); assert.equal(visto.o.redirect, 'manual');
    }
    visto = null;
    for (const [u, metodo] of [['https://esempio.it/.well-known/acme-challenge/a', 'GET'], ['http://altro.it/.well-known/acme-challenge/a', 'GET'],
      ['http://esempio.it/it', 'GET'], ['http://esempio.it/.well-known/acme-challenge/a?x=1', 'GET'], ['http://esempio.it/.well-known/acme-challenge/a', 'POST'],
      ['http://esempio.it/.well-known/acme-challenge/a/b', 'GET']]) assert.equal((await w.fetch(new Request(u, { method: metodo }))).status, 404);
    assert.equal(visto, null, 'nessun inoltro per le richieste rifiutate');
  } finally { globalThis.fetch = orig; }
});
