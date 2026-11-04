import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registroGitHub } from '../modelli/rilascio/adattatori.mjs';

const ENV = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' };
const REL = { sito: 'esempio.it', commit: 'a'.repeat(40), esito: 'completo' };
const risposta = (status, corpo = {}) => ({ status, ok: status < 300, json: async () => corpo });

test('registro: errore di rete sulla scrittura → si ritenta e si salva', async () => {
  let n = 0;
  const reg = registroGitHub(ENV, { attesaMs: 0, fetchFn: async () => { if (n++ === 0) throw new Error('fetch failed'); return risposta(200, { content: { sha: 'v2' } }); } });
  assert.equal(await reg.salva(REL, 'v1'), 'v2');
});

test('registro: la scrittura "persa" era arrivata → conflitto, rilettura, contenuto nostro, versione accettata', async () => {
  let n = 0; const scritto = Buffer.from(`${JSON.stringify(REL, null, 2)}\n`).toString('base64');
  const reg = registroGitHub(ENV, { attesaMs: 0, fetchFn: async (u, o) => {
    if (o?.method === 'PUT') { if (n++ === 0) throw new Error('fetch failed'); return risposta(409); }
    return risposta(200, { sha: 'v2', content: scritto });
  } });
  assert.equal(await reg.salva(REL, 'v1'), 'v2');
});

test('registro: conflitto senza errori di rete → stop (un altro rilascio ha scritto)', async () => {
  const reg = registroGitHub(ENV, { attesaMs: 0, fetchFn: async () => risposta(409) });
  await assert.rejects(reg.salva(REL, 'v1'), /conflitto di versione/);
});

test('registro: rete giù per tutti i tentativi → errore', async () => {
  const reg = registroGitHub(ENV, { attesaMs: 0, fetchFn: async () => { throw new Error('fetch failed'); } });
  await assert.rejects(reg.salva(REL, 'v1'), /fetch failed/);
});
