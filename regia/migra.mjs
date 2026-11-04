#!/usr/bin/env node
// Punto d'ingresso della regia: node regia/migra.mjs siti/<sito>.json
// Legge la scheda, controlla lo stato, esegue la fase richiesta, scrive stato/<sito>.json
// (commit e push) e avvisa su Telegram. Exit 1 su FAIL. I servizi sono in lib/servizi.mjs.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { validaScheda } from './lib/scheda.mjs';
import { nuovoStato, precedentePass, apriFase, chiudiFase, ORDINE } from './lib/stato.mjs';
import * as servizi from './lib/servizi.mjs';
import { prepara } from './fasi/prepara.mjs';
import { collaudo } from './fasi/collaudo.mjs';
import { cutover } from './fasi/cutover.mjs';
import { failover } from './fasi/failover.mjs';
import { chiudi } from './fasi/chiudi.mjs';

export const FASI = { prepara, collaudo, cutover, failover, chiudi };
const RADICE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function serviziReali(env, config, radice = RADICE) {
  return {
    gh: servizi.github(env), vercel: servizi.vercel(env), coolify: servizi.coolify(env, config),
    cloudflare: servizi.cloudflare({ ...env, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_WORKERS_TOKEN }),
    regia: servizi.regia({ radice }), http: servizi.http(), avvisa: servizi.telegram(env), esegui: servizi.eseguiReale, sleep: servizi.sleepReale,
    ora: () => new Date().toISOString(), log: m => console.log(m),
  };
}

/** Esegue una fase e scrive lo stato. Ritorna {esito, messaggio}. s = servizi (reali o finti). */
export async function migra(percorsoScheda, { env, config, s, testo = null }) {
  const scheda = validaScheda(JSON.parse(testo ?? await readFile(percorsoScheda, 'utf8')), config);
  const fase = scheda.fase;
  const percorsoStato = `stato/${scheda.sito}.json`;
  const stato = s.regia.leggi(percorsoStato) || nuovoStato(scheda.sito);
  if (fase === 'nessuna') return { esito: 'NIENTE', messaggio: `${scheda.sito}: fase "nessuna", nessuna azione` };
  if (!FASI[fase]) {
    const m = `${scheda.sito}: fase "${fase}" non ancora implementata nella regia (prossima sessione)`;
    s.log(m); return { esito: 'NON_IMPLEMENTATA', messaggio: m };
  }
  const prec = precedentePass(stato, fase);
  if (prec) {
    const m = `${scheda.sito}: la fase ${fase} richiede ${prec} PASS (ora: ${stato.fasi?.[prec]?.esito || 'mai eseguita'})`;
    s.log(m); await s.avvisa(`STOP migrazione ${m}`); return { esito: 'FAIL', messaggio: m };
  }
  if (stato.fasi[fase]?.esito === 'IN_CORSO') s.log(`attenzione: ${fase} risultava IN_CORSO (run ${stato.fasi[fase].run}), si riparte`);
  apriFase(stato, fase, { run: env.GITHUB_RUN_ID || null, ora: s.ora() });
  // Le fasi successive tornano "da rifare" se se ne riesegue una precedente.
  for (const f of ORDINE.slice(ORDINE.indexOf(fase) + 1)) delete stato.fasi[f];
  s.regia.salva(percorsoStato, stato, `stato: ${scheda.sito} ${fase} in corso`);
  let esito = 'PASS', messaggio;
  try {
    messaggio = await FASI[fase](scheda, s, { env, config, stato, fase: stato.fasi[fase] });
    // Fase ferma in attesa di un ok di Lorenzo (es. cutover prima del DNS): non è PASS, la successiva non parte.
    if (stato.fasi[fase].sospesa) { esito = 'ATTESA'; delete stato.fasi[fase].sospesa; }
  }
  catch (e) {
    esito = 'FAIL'; messaggio = `${fase} FAIL per ${scheda.sito}: ${e.message}`;
    stato.fasi[fase].errore = e.message;
    if (e.name !== 'Stop' && e.name !== 'SchedaNonValida') s.log(e.stack || String(e));
  }
  chiudiFase(stato, fase, { esito, errore: stato.fasi[fase].errore, attesa: stato.fasi[fase].attesa, ora: s.ora() });
  s.regia.salva(percorsoStato, stato, `stato: ${scheda.sito} ${fase} ${esito}`);
  await s.avvisa(`${esito === 'PASS' ? 'MIGRAZIONE' : esito === 'ATTESA' ? 'MIGRAZIONE in attesa:' : 'STOP migrazione'} ${messaggio}`);
  s.log(messaggio);
  return { esito, messaggio };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const percorso = process.argv[2];
  if (!percorso) { console.error('uso: node regia/migra.mjs siti/<sito>.json'); process.exit(2); }
  const config = JSON.parse(await readFile(join(RADICE, 'regia', 'config.json'), 'utf8'));
  const env = process.env;
  let r;
  try {
    const fase = JSON.parse(await readFile(resolve(percorso), 'utf8')).fase;
    if (fase === 'nessuna') { console.log(`${percorso}: fase "nessuna", nessuna azione`); process.exit(0); }
    r = await migra(resolve(percorso), { env, config, s: serviziReali(env, config) });
  }
  catch (e) { console.error(`FAIL ${e.message}`); process.exit(1); }
  process.exit(['PASS', 'NIENTE', 'ATTESA'].includes(r.esito) ? 0 : 1);
}
