// Adattatori reali con fetch ed esegui finti: forma delle chiamate, rilettura dopo scrittura, errori.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { github, vercel, coolify, cloudflare, telegram, regia, redigi } from '../regia/lib/servizi.mjs';

function fetchFinto(risposte) {
  const chiamate = [];
  const f = async (url, init = {}) => {
    const u = String(url); chiamate.push({ url: u, metodo: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    for (const [re, r] of risposte) if (re.test(`${init.method || 'GET'} ${u}`)) { const x = typeof r === 'function' ? r(chiamate.at(-1)) : r; return { ok: (x.status || 200) < 300, status: x.status || 200, text: async () => JSON.stringify(x.json ?? {}) }; }
    return { ok: false, status: 599, text: async () => 'nessuna risposta finta' };
  };
  f.chiamate = chiamate; return f;
}
const ENV = { MIGRAZIONI_GH_TOKEN: 'github_pat_x', VERCEL_TOKEN: 'v', COOLIFY_TOKEN: 'c', CF_ACCESS_CLIENT_ID: 'i', CF_ACCESS_CLIENT_SECRET: 's', CLOUDFLARE_API_TOKEN: 'cf' };

test('github: file assente -> null, segreti via gh con il valore su stdin (mai in argv), ramo assente -> null', async () => {
  const f = fetchFinto([[/contents\/vercel\.json/, { status: 404 }], [/branches\/collaudo/, { status: 404 }], [/pulls\?state=open/, { json: [{ number: 2, html_url: 'u' }] }]]);
  const esec = []; const esegui = (c, a, o) => { esec.push([c, a, o]); return { status: 0, stdout: '' }; };
  const g = github(ENV, { fetchFn: f, esegui });
  assert.equal(await g.file('o/r', 'vercel.json', 'main'), null);
  assert.equal(await g.ramo('o/r', 'collaudo/x'), null);
  await g.segreto('o/r', 'TOK', 'segretissimo');
  assert.deepEqual(esec[0][1], ['secret', 'set', 'TOK', '--repo', 'o/r']); assert.equal(esec[0][2].input, 'segretissimo'); assert.equal(esec[0][2].env.GH_TOKEN, 'github_pat_x');
  await assert.rejects(g.segreto('o/r', 'TOK', ''), /valore vuoto/);
  assert.deepEqual(await g.prAperta('o/r', 'collaudo/x'), { numero: 2, url: 'u' });
  assert.match(f.chiamate.at(-1).url, /head=o%3Acollaudo%2Fx/);
  assert.equal(f.chiamate[0].headers.Authorization, 'Bearer github_pat_x');
});
test('vercel: bypass riusa quello esistente, altrimenti PATCH generate e rilettura', async () => {
  let f = fetchFinto([[/GET .*\/v9\/projects\/prj_1/, { json: { protectionBypass: { abc: { scope: 'automation-bypass' }, def: { scope: 'shareable-link' } } } }]]);
  assert.deepEqual(await vercel(ENV, { fetchFn: f }).bypass('prj_1', 'team_1'), { secret: 'abc', nuovo: false });
  assert.match(f.chiamate[0].url, /teamId=team_1$/);
  f = fetchFinto([[/GET .*\/v9\/projects\/prj_1/, { json: { protectionBypass: {} } }], [/PATCH .*\/v1\/projects\/prj_1\/protection-bypass/, { json: { protectionBypass: { nuovo: { scope: 'automation-bypass' } } } }]]);
  assert.deepEqual(await vercel(ENV, { fetchFn: f }).bypass('prj_1', 'team_1'), { secret: 'nuovo', nuovo: true });
  assert.deepEqual(f.chiamate[1].body, { generate: { note: 'regia migrazioni' } });
  f = fetchFinto([[/env/, { json: { envs: [{ key: 'A', target: ['production', 'preview'] }, { key: 'B', target: ['production'] }] } }]]);
  const n = await vercel(ENV, { fetchFn: f }).nomiVariabili('prj_1', 't'); assert.deepEqual([...n.production], ['A', 'B']); assert.deepEqual([...n.preview], ['A']);
});
test('coolify: header Access + Bearer, creazione con whoami e env, deploy POST con attesa fino a finished, failed -> errore', async () => {
  const stati = ['in_progress', 'finished'];
  const f = fetchFinto([[/POST .*\/applications\/dockerimage/, { json: { uuid: 'app1' } }], [/POST .*\/envs/, { json: {} }], [/POST .*\/deploy\?uuid=app1&force=false/, { json: { deployments: [{ deployment_uuid: 'd1' }] } }],
    [/GET .*\/deployments\/d1/, () => ({ json: { status: stati.shift() } })], [/GET .*\/projects/, { json: [{ name: 'x', uuid: 'p1' }] }]]);
  const c = coolify(ENV, { coolifyUrl: 'https://coolify.test' }, { fetchFn: f, sleep: async () => {} });
  assert.equal(await c.progettoUuid('x'), 'p1');
  assert.equal(await c.creaRisorsaImmagine({ progetto: 'p1', server: 's', destinazione: 'd', nome: 'n', dominio: 'https://collaudo-n.lorentso.it' }), 'app1');
  assert.equal(f.chiamate[1].body.docker_registry_image_name, 'traefik/whoami'); assert.equal(f.chiamate[1].body.instant_deploy, false);
  assert.equal(f.chiamate[1].headers['CF-Access-Client-Id'], 'i'); assert.equal(f.chiamate[1].headers.Authorization, 'Bearer c');
  assert.equal(await c.deploy('app1'), 'd1');
  assert.equal(f.chiamate.filter(x => /deployments\/d1/.test(x.url)).length, 2);
  const f2 = fetchFinto([[/POST .*deploy/, { json: { deployments: [{ deployment_uuid: 'd2' }] } }], [/deployments\/d2/, { json: { status: 'failed' } }]]);
  await assert.rejects(coolify(ENV, { coolifyUrl: 'https://coolify.test' }, { fetchFn: f2 }).deploy('a'), /deploy Coolify failed/);
});
test('cloudflare: zona per nome, record proxied, errore con i messaggi API', async () => {
  const f = fetchFinto([[/zones\?name=lorentso\.it/, { json: { success: true, result: [{ id: 'z1' }] } }], [/GET .*dns_records\?name=/, { json: { success: true, result: [] } }],
    [/POST .*dns_records/, { json: { success: true, result: { id: 'r1' } } }]]);
  const cf = cloudflare(ENV, { fetchFn: f });
  assert.equal(await cf.zona('lorentso.it'), 'z1');
  assert.deepEqual(await cf.record('z1', 'collaudo-x.lorentso.it'), []);
  await cf.creaA('z1', 'collaudo-x.lorentso.it', '10.0.0.1');
  assert.equal(f.chiamate[2].body.proxied, true); assert.equal(f.chiamate[2].body.type, 'A');
  const f2 = fetchFinto([[/zones/, { status: 403, json: { success: false, errors: [{ code: 9109, message: 'Unauthorized' }] } }]]);
  await assert.rejects(cloudflare(ENV, { fetchFn: f2 }).zona('lorentso.it'), /HTTP 403.*Unauthorized/);
});
test('telegram: senza token non invia; con token un POST con il link al run', async () => {
  const f = fetchFinto([[/telegram/, { json: {} }]]);
  assert.equal(await telegram({}, { fetchFn: f })('x'), false);
  assert.equal(await telegram({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1', GITHUB_RUN_ID: '5', GITHUB_SERVER_URL: 'https://gh', GITHUB_REPOSITORY: 'o/r' }, { fetchFn: f })('ciao'), true);
  assert.equal(f.chiamate[0].body.text, 'ciao\nhttps://gh/o/r/actions/runs/5');
});
test('regia: salva fa commit, pull --rebase e push una volta; niente commit se il file non cambia; leggiRemoto usa git show', async () => {
  const radice = mkdtempSync(join(tmpdir(), 'regia-')); mkdirSync(join(radice, 'stato'));
  const git = []; let senzaCambi = false; const esegui = (c, a0, o) => { const a = a0.filter(x => !x.startsWith('-c') && !/regia/.test(x)); git.push(a.join(' ')); if (a[0] === 'diff') return { status: senzaCambi ? 0 : 1 }; if (a[0] === 'show') return { status: 0, stdout: '{"esito":"PASS"}' }; return { status: 0, stdout: '' }; };
  const r = regia({ radice, esegui, sleep: async () => {} });
  assert.equal(r.salva('stato/x.json', { a: 1 }, 'msg'), true);
  assert.deepEqual(git, ['add stato/x.json', 'diff --cached --quiet', 'commit --quiet -m msg', 'pull --quiet --rebase origin main', 'push --quiet origin HEAD:main']);
  git.length = 0; senzaCambi = true; assert.equal(r.salva('stato/x.json', { a: 1 }, 'msg'), false); assert.equal(git.length, 2);
  assert.deepEqual(r.leggi('stato/x.json'), { a: 1 });
  assert.deepEqual(await r.attendi('vps/esiti/u.json', e => e.esito === 'PASS', { attesaMs: 0, limiteMs: 1 }), { esito: 'PASS' });
  assert.ok(git.includes('fetch --quiet origin main'));
});
test('regia reale con git vero: salva e attendi funzionano contro un remoto locale', async () => {
  const remoto = mkdtempSync(join(tmpdir(), 'remoto-')); spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remoto]);
  const radice = mkdtempSync(join(tmpdir(), 'clone-'));
  const g = (...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: radice, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
  g('init', '-q', '-b', 'main'); g('remote', 'add', 'origin', remoto); writeFileSync(join(radice, 'README.md'), 'x'); g('add', '.'); g('commit', '-q', '-m', 'inizio'); g('push', '-q', '-u', 'origin', 'main');
  const r = regia({ radice, sleep: async () => {} });
  assert.equal(r.salva('vps/registro.json', { risorse: [] }, 'vps: prova'), true);
  assert.deepEqual(r.leggiRemoto('vps/registro.json'), { risorse: [] });
  // Un "agente" scrive l'esito direttamente sul remoto: attendi lo vede dopo il fetch.
  const altro = mkdtempSync(join(tmpdir(), 'agente-')); spawnSync('git', ['clone', '-q', remoto, altro]);
  mkdirSync(join(altro, 'vps/esiti'), { recursive: true }); writeFileSync(join(altro, 'vps/esiti/u.json'), '{"esito":"PASS"}');
  spawnSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'add', '.'], { cwd: altro }); spawnSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-q', '-m', 'esito'], { cwd: altro }); spawnSync('git', ['push', '-q'], { cwd: altro });
  assert.deepEqual(await r.attendi('vps/esiti/u.json', e => e.esito === 'PASS', { attesaMs: 0, limiteMs: 2000 }), { esito: 'PASS' });
  assert.equal(await r.attendi('vps/esiti/nessuno.json', () => true, { attesaMs: 0, limiteMs: 1 }), null);
  // Scrittura successiva della regia con il remoto avanzato: pull --rebase e push riescono.
  assert.equal(r.salva('stato/s.json', { fasi: {} }, 'stato'), true);
  assert.match(spawnSync('git', ['log', '--oneline', 'origin/main'], { cwd: radice, encoding: 'utf8' }).stdout, /stato/);
});
test('redigi: i token non finiscono nei messaggi di errore', () => {
  assert.equal(redigi('fatal: https://x-access-token:github_pat_ABC@github.com/o/r.git non trovato; ghp_zzz'), 'fatal: https://x-access-token:***@github.com/o/r.git non trovato; ghp_***');
});
