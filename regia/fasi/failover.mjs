// Fase "failover" (procedura v5 C7): Worker di failover del sito davanti alla VPS, con Vercel in
// standby su backup.<dominio>. WORKER_FAILOVER=attivo → un rilascio pubblica il Worker con la lista
// asset della release; route del Worker sui nomi del sito (fail open); prova di guasto: l'agente VPS
// mette in pausa il container e la regia controlla che le pagine pubbliche arrivino dal backup.
// Cosa NON protegge: POST, API, anteprime, sessioni, guasti delle dipendenze esterne.
import { Stop } from '../lib/servizi.mjs';
import { rilascio, verificaAgente, finche, sbloccaRegistro } from '../lib/comuni.mjs';
import { nomiWeb } from './cutover.mjs';

export const rotteFailover = scheda => nomiWeb(scheda).map(n => `${n}/*`);

export async function failover(scheda, s, { env, config, stato, fase }) {
  const passo = (nome, esito) => { fase.passi.push({ nome, esito, quando: s.ora() }); s.log(`${nome}: ${esito}`); };
  const v = stato.valori; v.failover = v.failover || {};
  const uuid = v.coolifyAppUuid;
  const worker = scheda.worker.nome;

  // 1. Configurazione del Worker nel repo del sito (scritta da prepara, adattabile in C7)
  for (const p of ['.github/rilascio/worker/worker-sito.mjs', `.github/rilascio/worker/siti/${scheda.sito}.mjs`, '.github/rilascio/worker/wrangler.jsonc']) {
    if (!(await s.gh.file(scheda.repo, p, scheda.ramo))) throw new Stop(`manca ${p} su ${scheda.ramo} del sito`);
  }
  passo('configurazione del Worker', `presente su ${scheda.ramo} (${worker})`);

  // 2. WORKER_FAILOVER=attivo e rilascio che pubblica il Worker con la lista asset
  const vars = await s.gh.variabili(scheda.repo);
  if (vars.DOMINIO_OVERRIDE) throw new Stop('DOMINIO_OVERRIDE è ancora impostata: il cutover non è finito');
  if (vars.WORKER_FAILOVER !== 'attivo' || !v.failover.pubblicato) {
    const sbloccato = await sbloccaRegistro(s, scheda, config, stato, { ramo: scheda.ramo });
    if (sbloccato) passo('sblocco del registro', sbloccato);
    await s.gh.variabile(scheda.repo, 'WORKER_FAILOVER', 'attivo');
    await s.gh.variabile(scheda.repo, 'CLOUDFLARE_ACCOUNT_ID', config.cloudflareAccountId);
    const r = await rilascio(s, scheda, config, { ramo: scheda.ramo, lancia: true });
    v.failover.pubblicato = r.release.commit;
    passo('rilascio con il Worker', `completo (run ${r.run.id}), Worker ${worker} pubblicato`);
  } else passo('rilascio con il Worker', `già fatto per ${String(v.failover.pubblicato).slice(0, 7)}`);

  // 3. Route del Worker sui nomi del sito (le richieste del Worker ACME, se c'è ancora, restano sue: route più specifiche)
  const zona = await s.cloudflare.zona(scheda.dominio);
  const rotte = await s.cloudflare.rotte(zona);
  const create = [];
  for (const schema of rotteFailover(scheda)) {
    const r = rotte.find(x => x.schema === schema);
    if (!r) { await s.cloudflare.creaRotta(zona, schema, worker); create.push(schema); }
    else if (r.script !== worker) throw new Stop(`la route ${schema} esiste già con un altro Worker (${r.script})`);
  }
  passo('route del Worker', create.length ? `create ${create.join(', ')}` : 'già presenti');

  // 4. Il sito risponde ancora dalla VPS con il Worker davanti
  const pagina = `https://${scheda.dominio}${scheda.rilascio.pagine.split(' ')[0]}`;
  const prima = await finche(s, pagina, r => r.status === 200, { limiteMs: 2 * 60000 });
  if (prima.status !== 200) await rollback(s, zona, scheda, `${pagina} → HTTP ${prima.status} con il Worker attivo`);
  if (prima.headers['x-served-by'] === 'vercel-hot-standby') await rollback(s, zona, scheda, `${pagina} servita dal backup con la VPS sana`);
  passo('sito con il Worker', `${pagina} 200 dalla VPS`);

  // 5. Prova di guasto: pausa del container (agente VPS) e sonde finché la pausa dura
  const secondi = 120;
  const id = `${scheda.sito}-failover-pausa-${Date.now().toString(36)}`;
  const sonde = { totali: 0, backup: 0, errori: [] };
  const sonda = async () => {
    const r = await s.http(pagina, { headers: { Accept: 'text/html' }, timeoutMs: 12000 });
    sonde.totali++;
    if (r.status === 200 && r.headers['x-served-by'] === 'vercel-hot-standby') sonde.backup++;
    else if (r.status !== 200) sonde.errori.push(r.status);
  };
  // L'agente lavora a giri: si sonda in parallelo finché l'esito della pausa non c'è.
  let finito = false;
  const sondeInCorso = (async () => { while (!finito) { await sonda(); await s.sleep(10000); } })();
  let esito;
  try { esito = await verificaAgente(s, config, { id, tipo: 'pausa', uuid, secondi }); }
  finally { finito = true; await sondeInCorso; }
  if (esito.esito !== 'PASS') throw new Stop(`prova di guasto non eseguita dall'agente: ${esito.dettagli}`);
  const dopo = await finche(s, pagina, r => r.status === 200 && r.headers['x-served-by'] !== 'vercel-hot-standby', { limiteMs: 3 * 60000 });
  v.failover.prova = { quando: s.ora(), ...sonde, errori: sonde.errori.slice(0, 10) };
  if (!sonde.backup) throw new Stop(`durante la pausa nessuna risposta dal backup (${sonde.totali} sonde, errori: ${sonde.errori.join(',') || 'nessuno'}): il Worker non fa failover`);
  if (dopo.status !== 200) throw new Stop(`dopo la pausa ${pagina} → HTTP ${dopo.status}`);
  passo('prova di guasto', `${esito.dettagli}; ${sonde.backup}/${sonde.totali} sonde servite dal backup, ${sonde.errori.length} errori; poi di nuovo dalla VPS`);

  return `failover PASS per ${scheda.sito}: Worker ${worker} attivo su ${rotteFailover(scheda).join(', ')}; con il container in pausa le pagine arrivano da ${scheda.backupDominio}.\nNon protegge POST, API, anteprime e sessioni. Prossimo: fase chiudi, dal giorno dopo il cutover.`;
}

async function rollback(s, zona, scheda, motivo) {
  for (const r of (await s.cloudflare.rotte(zona)).filter(r => rotteFailover(scheda).includes(r.schema) && r.script === scheda.worker.nome)) await s.cloudflare.cancellaRotta(zona, r.id);
  throw new Stop(`${motivo} (route del Worker tolte: sito di nuovo diretto sulla VPS)`);
}
