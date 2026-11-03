// Passo "Scheda cambiata" di migra.yml, eseguito con git vero: una sola scheda per push, mai _esempio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const yml = await readFile(new URL('../.github/workflows/migra.yml', import.meta.url), 'utf8');
const righe = yml.split('\n'); const i = righe.findIndex(l => /name: Scheda cambiata/.test(l)); const j = righe.findIndex((l, k) => k > i && /run: \|/.test(l));
const ind = righe[j + 1].match(/^\s*/)[0].length;
const corpo = []; for (const l of righe.slice(j + 1)) { if (l.trim() !== '' && l.match(/^\s*/)[0].length < ind) break; corpo.push(l.slice(ind)); }
const script = corpo.join('\n');

function repo() {
  const d = mkdtempSync(join(tmpdir(), 'wf-')); mkdirSync(join(d, 'siti'));
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8' }).stdout.trim();
  g('init', '-q', '-b', 'main'); writeFileSync(join(d, 'siti/_esempio.json'), '{}'); g('add', '.'); g('commit', '-q', '-m', 'base');
  const commit = (file) => { for (const [p, c] of Object.entries(file)) { if (c === null) g('rm', '-q', p); else writeFileSync(join(d, p), c); } g('add', '-A'); g('commit', '-q', '-m', 'x'); return g('rev-parse', 'HEAD'); };
  const esegui = prima => { const out = join(d, 'out'); writeFileSync(out, ''); const r = spawnSync('bash', ['-c', script], { cwd: d, encoding: 'utf8', env: { ...process.env, PRIMA: prima, GITHUB_OUTPUT: out } }); return { ...r, output: spawnSync('cat', [out], { encoding: 'utf8' }).stdout }; };
  return { g, commit, esegui };
}
test('una scheda cambiata: file= nell\'output', () => {
  const r = repo(); const prima = r.g('rev-parse', 'HEAD'); r.commit({ 'siti/x.json': '{"fase":"prepara"}' });
  const e = r.esegui(prima); assert.equal(e.status, 0, e.stdout + e.stderr); assert.match(e.output, /file=siti\/x\.json/); assert.match(e.stdout, /fase prepara/);
});
test('due schede, nessuna scheda (solo _esempio), scheda cancellata: FAIL', () => {
  let r = repo(); let prima = r.g('rev-parse', 'HEAD'); r.commit({ 'siti/x.json': '{}', 'siti/y.json': '{}' });
  assert.notEqual(r.esegui(prima).status, 0);
  r = repo(); prima = r.g('rev-parse', 'HEAD'); r.commit({ 'siti/_esempio.json': '{"a":1}' });
  assert.notEqual(r.esegui(prima).status, 0);
  r = repo(); r.commit({ 'siti/x.json': '{}' }); prima = r.g('rev-parse', 'HEAD'); r.commit({ 'siti/x.json': null });
  const e = r.esegui(prima); assert.notEqual(e.status, 0); assert.match(e.stdout, /cancellata/);
});
test('primo push (before = 0000…): si guarda il solo commit HEAD', () => {
  const r = repo(); r.commit({ 'siti/x.json': '{"fase":"nessuna"}' });
  const e = r.esegui('0'.repeat(40)); assert.equal(e.status, 0, e.stdout); assert.match(e.output, /file=siti\/x\.json/);
});
