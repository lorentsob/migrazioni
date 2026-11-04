// Passi comuni alle fasi cutover, failover e chiudi: verifiche dell'agente VPS e attesa dei
// rilasci del sito. Nessun segreto nei messaggi.
import { Stop } from './servizi.mjs';

/**
 * Chiede una verifica all'agente VPS (vps/registro.json → verifiche), aspetta l'esito, poi toglie la richiesta.
 * richiesta: {id, tipo, ...} (certificato: dominio; pausa: uuid, secondi). Ritorna l'esito {esito, dettagli}.
 * mentreAspetta: funzione chiamata a ogni giro di attesa (per esempio le sonde durante la pausa).
 */
export async function verificaAgente(s, config, richiesta, { scadeMinuti = 30 } = {}) {
  const registro = s.regia.leggi('vps/registro.json') || { schema: 'vps-registro/v1', risorse: [], verifiche: [] };
  registro.verifiche = registro.verifiche || [];
  if (!registro.verifiche.some(x => x.id === richiesta.id)) {
    registro.verifiche.push({ ...richiesta, richiesto: s.ora(), scade: new Date(Date.now() + scadeMinuti * 60000).toISOString() });
    s.regia.salva('vps/registro.json', registro, `vps: verifica ${richiesta.id}`);
  }
  const esito = await s.regia.attendi(`vps/esiti/${richiesta.id}.json`, e => ['PASS', 'FAIL', 'SCADUTA'].includes(e.esito), { limiteMs: config.attesaAgenteMinuti * 60000 });
  const reg2 = s.regia.leggi('vps/registro.json');
  if (reg2) { reg2.verifiche = (reg2.verifiche || []).filter(x => x.id !== richiesta.id); s.regia.salva('vps/registro.json', reg2, `vps: verifica ${richiesta.id} letta`); }
  if (!esito) throw new Stop(`l'agente VPS non ha risposto alla verifica ${richiesta.id} entro ${config.attesaAgenteMinuti} minuti: timer oracle-migrazioni attivo?`);
  return esito;
}

/** Certificato servito dalla VPS per ogni nome, letto dall'agente; un secondo tentativo dopo 2 minuti (emissione in corso). */
export async function certificatiOrigine(s, config, scheda, nomi, etichetta) {
  const det = [];
  for (const nome of nomi) {
    let e = null;
    for (let t = 1; t <= 2; t++) {
      e = await verificaAgente(s, config, { id: `${scheda.sito}-${etichetta}-cert-${nome.replace(/\./g, '-')}-${Date.now().toString(36)}-${t}`, tipo: 'certificato', dominio: nome });
      if (e.esito === 'PASS') break;
      if (t === 1) await s.sleep(120000);
    }
    if (e.esito !== 'PASS') throw new Stop(`certificato dall'origine per ${nome} non valido: ${e.dettagli}`);
    det.push(nome);
  }
  return det;
}

/**
 * Aspetta il rilascio-unico del sito per uno sha su un ramo (lanciandolo se `lancia`), poi legge il registro.
 * Ritorna {run, release}. Stop se fallisce, non parte o il registro non è "completo" per quello sha.
 */
export async function rilascio(s, scheda, config, { ramo = 'main', sha = null, lancia = false, registro = 'rilasci' }) {
  const prima = lancia ? (await s.gh.runDelRamo(scheda.repo, 'rilascio-unico.yml', ramo)).map(r => r.id) : [];
  if (lancia) await s.gh.lanciaWorkflow(scheda.repo, 'rilascio-unico.yml', ramo);
  // Con lancia conta solo il run lanciato dalla regia (workflow_dispatch, il più vecchio tra i nuovi):
  // un push di Lorenzo sullo stesso ramo nello stesso momento non va scambiato per il nostro.
  const scelto = runs => {
    const nuovi = runs.filter(r => !prima.includes(r.id) && (!sha || r.sha === sha) && (!lancia || !r.evento || r.evento === 'workflow_dispatch'));
    return (lancia ? nuovi[nuovi.length - 1] : nuovi[0]) || null;
  };
  const fine = Date.now() + config.attesaRilascioMinuti * 60000; let run = null;
  while (true) {
    run = scelto(await s.gh.runDelRamo(scheda.repo, 'rilascio-unico.yml', ramo));
    if (run && run.stato === 'completed') break;
    if (Date.now() > fine) break;
    await s.sleep(30000);
  }
  if (!run) throw new Stop(`il rilascio su ${ramo}${sha ? ` per ${sha.slice(0, 7)}` : ''} non è partito`);
  if (run.stato !== 'completed') throw new Stop(`rilascio su ${ramo} ancora in corso dopo ${config.attesaRilascioMinuti} minuti: ${run.url}`);
  const testo = await s.gh.file(scheda.repo, 'release.json', registro);
  const release = testo ? JSON.parse(testo) : null;
  if (run.esito !== 'success') throw new Stop(`rilascio su ${ramo} ${run.esito}: ${run.url}${release && release.esito !== 'completo' ? ` (registro "${release.esito}": ${release.motivo || '?'}; sblocco con rilascio-sblocca.yml)` : ''}`);
  if (!release || release.esito !== 'completo' || release.commit !== run.sha) throw new Stop(`run ${run.url} riuscito ma registro "${registro}" non completo per ${String(run.sha).slice(0, 7)}`);
  return { run, release };
}

/** Sonda ripetuta finché ok(risposta) o scade il tempo. Ritorna l'ultima risposta. */
export async function finche(s, url, ok, { limiteMs = 5 * 60000, attesaMs = 15000, opzioni = {} } = {}) {
  // Conta i giri invece del tempo: con le sonde da 15 s il totale resta vicino a limiteMs.
  let r;
  for (let giro = 0; ; giro++) {
    r = await s.http(url, opzioni);
    if (ok(r) || (giro + 1) * attesaMs >= limiteMs) return r;
    await s.sleep(attesaMs);
  }
}

export const revisione = r => { try { return JSON.parse(r.testo).revision || null; } catch { return null; } };
