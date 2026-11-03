import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validaScheda, dominiProduzione, FASI } from '../regia/lib/scheda.mjs';
import { SCHEDA, CONFIG } from './fixtures/servizi-finti.mjs';

test('scheda valida: default calcolati (collaudo, alias, immagine GHCR, riferimento Coolify)', () => {
  const s = validaScheda(SCHEDA, CONFIG);
  assert.equal(s.dominioCollaudo, 'collaudo-esempio.lorentso.it');
  assert.equal(s.aliasCollaudo, 'esempio-collaudo-lorentsob.vercel.app');
  assert.equal(s.rilascio.immagine, 'ghcr.io/lorentsob/esempio');
  assert.equal(s.rilascio.pagine, '/it /en');
  assert.equal(s.coolify.riferimento, CONFIG.coolifyRiferimento);
  assert.equal(s.coolify.nome, 'esempio-img');
  assert.equal(s.vercel.team, 'team_x');
  assert.equal(s.backupDominio, 'backup.esempio.it');
  assert.equal(dominiProduzione(s), 'https://esempio.it,https://www.esempio.it');
  assert.equal(dominiProduzione({ ...s, www: false }), 'https://esempio.it');
});
test('ogni campo sbagliato viene rifiutato con un messaggio che lo nomina', () => {
  const casi = [
    [{ schema: 'x' }, /schema/], [{ sito: 'Maiuscolo' }, /sito/], [{ fase: 'cutovre' }, /fase/], [{ repo: 'senza-owner' }, /repo/],
    [{ dominio: 'non valido' }, /dominio/], [{ www: 'si' }, /www/], [{ vercel: { progetto: 'abc' } }, /vercel\.progetto/],
    [{ statico: 'no' }, /statico/], [{ coolify: { riferimento: 'corto' } }, /riferimento/], [{ rilascio: { node: '22' } }, /node/],
  ];
  for (const [cambio, atteso] of casi) assert.throws(() => validaScheda({ ...SCHEDA, ...cambio }, CONFIG), atteso, JSON.stringify(cambio));
});
test('tutte le fasi previste sono accettate dalla scheda', () => {
  for (const fase of FASI) assert.equal(validaScheda({ ...SCHEDA, fase }, CONFIG).fase, fase);
});
