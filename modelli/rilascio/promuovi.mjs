// Passi 5-8 del rilascio unico (B.0): promozione VPS, promozione Vercel, verifica, registro.
// Regole:
//  - ogni operazione remota si tenta UNA volta; dopo si rilegge lo stato vero (readback);
//  - lo stato va in release.json prima e dopo ogni passo;
//  - se il release.json precedente non è "completo", o lo stato remoto non coincide
//    con quello registrato, ci si ferma prima di toccare qualcosa e si avvisa Lorenzo.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkManifest } from './asset.mjs';

export const SCHEMA = 'rilascio/v1';
const IMMAGINE = /^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/;
const DPL = /^dpl_[A-Za-z0-9]+$/;
// Coolify 4.4.7 rifiuta il digest come tag (B4, 422): la VPS usa un tag immutabile e unico per
// esecuzione, "<nome>:<commit>-r<run>-<tentativo>" (il rollback ricostruisce un commit già pubblicato).
// La forma "<nome>:<commit>" resta accettata per i registri del collaudo B4.
const IMMAGINE_VPS = /^[a-z0-9./_-]+:([a-f0-9]{40})(-r[0-9]+-[0-9]+)?$/;
const COMMIT = /^[a-f0-9]{40}$/;

export class Stop extends Error {
  constructor(message, stato = null) { super(message); this.name = 'Stop'; this.stato = stato; }
}

function nuovoPasso() { return { stato: 'da_fare', tentativi: 0, inizio: null, fine: null, letto: null, nota: null }; }

export function validaCandidato(c) {
  if (!c || typeof c.sito !== 'string' || !/^[a-z0-9.-]+$/.test(c.sito)) throw new Stop('candidato: sito non valido');
  if (!COMMIT.test(c.commit || '')) throw new Stop('candidato: serve il commit completo');
  if (!IMMAGINE.test(c.immagine || '')) throw new Stop('candidato: immagine senza digest sha256');
  if (c.immagineVps != null && !IMMAGINE_VPS.test(c.immagineVps)) throw new Stop('candidato: riferimento VPS non è nome:<commit>-r<run>-<tentativo>');
  if (c.immagineVps != null && IMMAGINE_VPS.exec(c.immagineVps)[1] !== c.commit) throw new Stop('candidato: tag VPS di un altro commit');
  if (!DPL.test(c.vercelDeployment || '')) throw new Stop('candidato: id deployment Vercel non valido');
  if (!['release', 'rollback'].includes(c.modalita || 'release')) throw new Stop('candidato: modalità non valida');
  if (!c.asset || !Number.isSafeInteger(c.asset.count) || !/^[a-f0-9]{64}$/.test(c.asset.setDigest || '')) throw new Stop('candidato: asset non validi');
  try { checkManifest(c.propri); } catch { throw new Stop('candidato: manifest degli asset propri non valido'); }
  if (c.propri.revision !== c.commit) throw new Stop('candidato: manifest propri di un altro commit');
  return c;
}

/**
 * a (adattatori): leggiRegistro() -> { release, versione } | null
 *   salvaRegistro(release, versione) -> nuovaVersione  (scrittura con controllo di versione)
 *   leggiVps() -> riferimento immagine attivo su Coolify ("nome@sha256:...")
 *   aggiornaVps(immagine) -> deploy Coolify e attesa fine (nessun ritentativo)
 *   saluteVps() -> commit letto da /api/health del dominio pubblico
 *   leggiVercel() -> id del deployment servito dal dominio di backup
 *   promuoviVercel(id) -> promozione del deployment verificato
 *   verifica() -> true/false (verifica-sito.sh)
 *   avvisa(testo) -> notifica (Telegram); i suoi errori non cambiano l'esito
 *   ora() -> ISO string (opzionale)
 */
export async function promuovi(candidato, a, log = () => {}) {
  validaCandidato(candidato);
  const rifVps = r => r?.immagineVps ?? r?.immagine; // riferimento che Coolify mostra
  const ora = a.ora || (() => new Date().toISOString());
  const prev = await a.leggiRegistro();
  if (prev && prev.release?.schema !== SCHEMA) throw await fermati(a, 'release.json precedente illeggibile o di un altro formato: serve un controllo di Lorenzo');
  if (prev && prev.release.esito !== 'completo') {
    throw await fermati(a, `release precedente ${prev.release.commit?.slice(0, 7)} in stato "${prev.release.esito}": stato parziale, nessuna azione. Serve una decisione di Lorenzo.`);
  }
  let attuale;
  try { attuale = { immagine: await a.leggiVps(), vercelDeployment: await a.leggiVercel() }; }
  catch (e) { throw await fermati(a, `lettura dello stato attuale fallita (${e.message}): nessuna azione`); }
  if (prev && (attuale.immagine !== rifVps(prev.release) || attuale.vercelDeployment !== prev.release.vercelDeployment)) {
    throw await fermati(a, 'lo stato remoto non coincide con release.json (qualcuno ha cambiato VPS o Vercel a mano): nessuna azione');
  }
  if (attuale.immagine === rifVps(candidato) && attuale.vercelDeployment === candidato.vercelDeployment) {
    throw await fermati(a, 'il candidato è già quello in produzione: niente da fare');
  }

  const stato = {
    schema: SCHEMA, sito: candidato.sito, modalita: candidato.modalita || 'release', runId: candidato.runId ?? null,
    commit: candidato.commit, immagine: candidato.immagine, immagineVps: candidato.immagineVps ?? null, vercelDeployment: candidato.vercelDeployment,
    vercelUrl: candidato.vercelUrl ?? null, asset: candidato.asset, propri: candidato.propri,
    // Release da cui si conservano gli asset (B5: le 2 precedenti più la corrente).
    storico: prev?.release.storico ?? [],
    precedente: { commit: prev?.release.commit ?? null, ...attuale },
    passi: { vps: nuovoPasso(), vercel: nuovoPasso(), verifica: nuovoPasso() },
    esito: 'in_corso', motivo: null, iniziato: ora(), aggiornato: ora(),
  };
  let versione = prev?.versione ?? null;
  const salva = async () => {
    stato.aggiornato = ora();
    try { versione = await a.salvaRegistro(structuredClone(stato), versione); }
    catch (e) { throw new Stop(`release.json non salvato (${e.message}); stato in memoria: ${JSON.stringify(stato)}`, stato); }
  };
  const chiudi = async (motivo) => {
    stato.esito = 'fermo'; stato.motivo = motivo;
    await salva();
    await avvisa(a, `STOP rilascio ${stato.sito} ${stato.commit.slice(0, 7)}: ${motivo}`);
    return new Stop(motivo, stato);
  };
  await salva();

  // 5. PROMOZIONE VPS
  const vps = stato.passi.vps;
  Object.assign(vps, { stato: 'in_corso', tentativi: 1, inizio: ora() });
  await salva();
  let errore = null;
  try { await a.aggiornaVps(rifVps(candidato)); } catch (e) { errore = e.message; }
  try {
    vps.letto = await a.leggiVps();
    const salute = vps.letto === rifVps(candidato) ? await a.saluteVps() : null;
    if (vps.letto === rifVps(candidato) && salute === candidato.commit) vps.stato = 'ok';
    else if (vps.letto === attuale.immagine) { vps.stato = 'fallito'; vps.nota = errore || 'Coolify è rimasto sulla release precedente'; }
    else { vps.stato = 'incerto'; vps.nota = `${errore ? errore + '; ' : ''}immagine letta ${vps.letto}, health ${salute}`; }
  } catch (e) { vps.stato = 'incerto'; vps.nota = `rilettura impossibile: ${e.message}`; }
  vps.fine = ora();
  log(`passo 5 VPS: ${vps.stato}`);
  if (vps.stato !== 'ok') throw await chiudi(`passo 5 (VPS) ${vps.stato}: ${vps.nota}. Nessun nuovo tentativo.`);
  await salva();

  // 6. PROMOZIONE VERCEL
  const vc = stato.passi.vercel;
  Object.assign(vc, { stato: 'in_corso', tentativi: 1, inizio: ora() });
  await salva();
  errore = null;
  try { await a.promuoviVercel(candidato.vercelDeployment); } catch (e) { errore = e.message; }
  try {
    vc.letto = await a.leggiVercel();
    if (vc.letto === candidato.vercelDeployment) vc.stato = 'ok';
    else if (vc.letto === attuale.vercelDeployment) { vc.stato = 'fallito'; vc.nota = errore || 'il backup serve ancora la release precedente'; }
    else { vc.stato = 'incerto'; vc.nota = `${errore ? errore + '; ' : ''}deployment letto ${vc.letto}`; }
  } catch (e) { vc.stato = 'incerto'; vc.nota = `rilettura impossibile: ${e.message}`; }
  vc.fine = ora();
  log(`passo 6 Vercel: ${vc.stato}`);
  if (vc.stato !== 'ok') throw await chiudi(`passo 6 (Vercel) ${vc.stato}: ${vc.nota}. VPS già sulla release nuova, Vercel no: stato parziale noto. Nessun nuovo tentativo.`);
  await salva();

  // 7. VERIFICA
  const vf = stato.passi.verifica;
  Object.assign(vf, { stato: 'in_corso', tentativi: 1, inizio: ora() });
  await salva();
  let passa = false;
  try { passa = (await a.verifica()) === true; } catch (e) { vf.nota = e.message; }
  vf.stato = passa ? 'ok' : 'fallito';
  vf.fine = ora();
  log(`passo 7 verifica: ${vf.stato}`);
  if (!passa) throw await chiudi('passo 7 (verifica-sito.sh) fallito con entrambi i lati promossi: controllare a mano, nessun rollback automatico.');

  // 8. REGISTRO
  stato.esito = 'completo';
  stato.storico = [{ commit: stato.commit, immagine: stato.immagine, immagineVps: stato.immagineVps, vercelDeployment: stato.vercelDeployment, propri: candidato.propri },
    ...stato.storico.filter(s => s.immagine !== stato.immagine)].slice(0, 3);
  await salva();
  return stato;
}

/**
 * Sblocco dopo uno STOP (review 3/11, R1). Lo lancia solo Lorenzo (workflow manuale
 * rilascio-sblocca.yml). Non ripara alla cieca: rilegge VPS e Vercel e agisce solo se lo
 * stato vero coincide con quello richiesto dall'azione. Una sola chiamata di modifica al massimo.
 *  - "ripristina":      VPS e Vercel sono ancora sulla release precedente → il registro torna a quella.
 *  - "accetta":         VPS e Vercel sono già sul candidato (es. verifica fallita ma controllata a mano) → completo.
 *  - "completa-vercel": VPS sul candidato, Vercel sul precedente (STOP al passo 6) → una promozione
 *                       Vercel del deployment registrato, rilettura, verifica, poi completo.
 */
export const AZIONI_SBLOCCO = ['ripristina', 'accetta', 'completa-vercel'];
export async function sblocca(azione, a, { motivo = '', runId = null } = {}) {
  if (!AZIONI_SBLOCCO.includes(azione)) throw new Stop(`azione di sblocco sconosciuta: ${azione}`);
  if (!motivo.trim()) throw new Stop('sblocco: serve un motivo scritto');
  const ora = a.ora || (() => new Date().toISOString());
  const reg = await a.leggiRegistro();
  if (!reg || reg.release?.schema !== SCHEMA) throw new Stop('sblocco: registro assente o di un altro formato');
  const r = reg.release;
  if (r.esito === 'completo') throw new Stop('sblocco: il registro è già completo, niente da sbloccare');
  const rifVps = x => x?.immagineVps ?? x?.immagine;
  const vps = await a.leggiVps(), vercel = await a.leggiVercel();
  const nuovo = { vps: rifVps(r), vercel: r.vercelDeployment };
  const vecchio = { vps: r.precedente?.immagine ?? null, vercel: r.precedente?.vercelDeployment ?? null };
  const nota = { azione, motivo, runId, da: { commit: r.commit, esito: r.esito, motivo: r.motivo }, quando: ora() };
  let release;
  if (azione === 'ripristina') {
    if (vps !== vecchio.vps || vercel !== vecchio.vercel) throw new Stop(`sblocco ripristina: lo stato vero (VPS ${vps}, Vercel ${vercel}) non è quello precedente`);
    const p = (r.storico || [])[0];
    if (!p || p.commit !== r.precedente.commit || rifVps(p) !== vecchio.vps || p.vercelDeployment !== vecchio.vercel) {
      throw new Stop('sblocco ripristina: la release precedente non è nello storico (primo rilascio?): serve un controllo a mano');
    }
    release = { schema: SCHEMA, sito: r.sito, modalita: 'ripristino', runId, commit: p.commit, immagine: p.immagine, immagineVps: p.immagineVps ?? null,
      vercelDeployment: p.vercelDeployment, vercelUrl: null, asset: null, storico: r.storico, precedente: null, passi: null,
      esito: 'completo', motivo: null, sblocco: nota, iniziato: ora(), aggiornato: ora() };
  } else {
    if (vps !== nuovo.vps) throw new Stop(`sblocco ${azione}: la VPS (${vps}) non è sul candidato ${nuovo.vps}`);
    if (azione === 'accetta' && vercel !== nuovo.vercel) throw new Stop(`sblocco accetta: Vercel (${vercel}) non è sul candidato`);
    if (azione === 'completa-vercel') {
      if (vercel !== vecchio.vercel) throw new Stop(`sblocco completa-vercel: Vercel (${vercel}) non è né il precedente né il candidato atteso`);
      let errore = null;
      try { await a.promuoviVercel(r.vercelDeployment); } catch (e) { errore = e.message; }
      const letto = await a.leggiVercel();
      if (letto !== r.vercelDeployment) throw new Stop(`sblocco completa-vercel: promozione non riuscita (${errore || 'letto ' + letto}). Nessun nuovo tentativo.`);
      if ((await a.verifica()) !== true) throw new Stop('sblocco completa-vercel: Vercel promosso ma verifica-sito fallita: controllare a mano');
    }
    release = { ...structuredClone(r), esito: 'completo', motivo: null, sblocco: nota, aggiornato: ora(),
      storico: [{ commit: r.commit, immagine: r.immagine, immagineVps: r.immagineVps ?? null, vercelDeployment: r.vercelDeployment, propri: r.propri ?? null },
        ...(r.storico || []).filter(s => s.immagine !== r.immagine)].slice(0, 3) };
  }
  await a.salvaRegistro(release, reg.versione);
  await avvisa(a, `SBLOCCO ${r.sito} (${azione}): registro di nuovo completo su ${release.commit.slice(0, 7)}. Motivo: ${motivo}`);
  return release;
}

async function avvisa(a, testo) { try { await a.avvisa?.(testo); } catch { /* l'avviso non cambia l'esito */ } }
async function fermati(a, motivo) { await avvisa(a, `STOP rilascio: ${motivo}`); return new Stop(motivo); }

// ---- Modalità finta: adattatori su file locali, per i test e per provare il flusso ----
export function adattatoriFinti(dir, { fallisci = null } = {}) {
  const f = name => resolve(dir, name);
  const json = async (name, fallback) => { try { return JSON.parse(await readFile(f(name), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
  const testo = async name => { try { return await readFile(f(name), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  const impronta = t => createHash('sha256').update(t).digest('hex');
  const conta = async (k) => { const c = await json('chiamate.json', {}); c[k] = (c[k] || 0) + 1; await writeFile(f('chiamate.json'), JSON.stringify(c)); };
  const remoto = () => json('remoto.json', null);
  const scriviRemoto = r => writeFile(f('remoto.json'), JSON.stringify(r));
  return {
    // Versione = hash del contenuto: stesso controllo di versione del registro su GitHub (sha del blob).
    async leggiRegistro() { const t = await testo('release.json'); return t && { release: JSON.parse(t), versione: impronta(t) }; },
    async salvaRegistro(release, versione) {
      const t = await testo('release.json');
      if ((t && impronta(t)) !== (versione ?? null)) throw new Error('conflitto di versione su release.json');
      const nuovo = `${JSON.stringify(release, null, 2)}\n`;
      await writeFile(f('release.json'), nuovo); return impronta(nuovo);
    },
    async leggiVps() { return (await remoto()).immagine; },
    async aggiornaVps(immagine) { await conta('aggiornaVps'); if (fallisci === 'passo5') throw new Error('deploy Coolify fallito (finto)'); const r = await remoto(); r.immagine = immagine; r.commitVps = r.prossimoCommit; await scriviRemoto(r); },
    async saluteVps() { return (await remoto()).commitVps; },
    async leggiVercel() { return (await remoto()).vercelDeployment; },
    async promuoviVercel(id) { await conta('promuoviVercel'); if (fallisci === 'passo6') throw new Error('promozione Vercel fallita (finta)'); const r = await remoto(); r.vercelDeployment = id; await scriviRemoto(r); },
    async verifica() { await conta('verifica'); return fallisci !== 'passo7'; },
    async avvisa(testo) { await conta('avvisa'); const l = await json('avvisi.json', []); l.push(testo); await writeFile(f('avvisi.json'), JSON.stringify(l)); },
  };
}

async function main(argv) {
  const opt = Object.fromEntries(argv.map(x => { const [k, ...v] = x.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
  if (opt.sblocca) {
    const { adattatoriReali } = await import('./adattatori.mjs');
    const reg = await import('./adattatori.mjs').then(m => m.registroGitHub(process.env).leggi());
    if (!reg) throw new Stop('sblocco: registro assente');
    const r = await sblocca(opt.sblocca, adattatoriReali(process.env, reg.release), { motivo: String(opt.motivo || ''), runId: process.env.GITHUB_RUN_ID || null });
    console.log(`ESITO sblocco ${opt.sblocca}: registro completo su ${r.commit}`);
    return;
  }
  const candidato = JSON.parse(await readFile(opt.candidato, 'utf8'));
  let adattatori;
  if (opt.finto) {
    adattatori = adattatoriFinti(opt.dir, { fallisci: opt.finto === 'nessuno' ? null : opt.finto });
  } else {
    const { adattatoriReali } = await import('./adattatori.mjs');
    adattatori = adattatoriReali(process.env, candidato);
  }
  const stato = await promuovi(candidato, adattatori, m => console.log(m));
  console.log(`ESITO completo: ${stato.sito} ${stato.commit} ${stato.immagine} ${stato.vercelDeployment}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(e => {
    console.error(`${e.name === 'Stop' ? 'STOP' : 'ERRORE'}: ${e.message}`);
    process.exitCode = 1;
  });
}
