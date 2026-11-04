// Fase "cutover" (procedura v5 C5 + C6). Due parti nella stessa fase:
//  A. preparazione, senza effetti sul sito pubblico (resta su Vercel): export della zona, variabili
//     Vercel → risorsa Coolify, dominio di backup su Vercel, Worker ACME temporaneo, domini veri
//     sulla risorsa e certificati dall'origine. Senza "ok cutover DNS" nella scheda la fase si
//     ferma qui con esito ATTESA.
//  B. con l'ok di Lorenzo (scheda.ok.cutover): merge della PR con DOMINIO_OVERRIDE (primo rilascio
//     verificato sul nome di collaudo), record web verso la VPS con la posta intatta, secondo
//     rilascio verificato sul dominio vero. Se un controllo fallisce dopo il cambio DNS, i record
//     tornano quelli dell'export (rollback automatico) e la fase si ferma.
// Idempotente: ogni passo legge prima di scrivere, quindi si può rilanciare dopo uno stop.
import { Stop } from '../lib/servizi.mjs';
import { dominiProduzione } from '../lib/scheda.mjs';
import { codiceAcme, nomeAcme, origineAcme, rotteAcme } from '../lib/acme.mjs';
import { certificatiOrigine, rilascio, finche, revisione } from '../lib/comuni.mjs';
import { MODELLI } from '../lib/modelli.mjs';
import { join } from 'node:path';

const WEB = ['A', 'AAAA', 'CNAME'];
export const DA_TOGLIERE_SU_COOLIFY = ['WHOAMI_PORT_NUMBER'];
export const percorsoExport = scheda => `stato/zone/${scheda.sito}-prima-del-cutover.json`;
export const nomiWeb = scheda => [scheda.dominio, ...(scheda.www ? [`www.${scheda.dominio}`] : [])];

export async function cutover(scheda, s, { env, config, stato, fase }) {
  const passo = (nome, esito) => { fase.passi.push({ nome, esito, quando: s.ora() }); s.log(`${nome}: ${esito}`); };
  const v = stato.valori; v.cutover = v.cutover || {};
  const uuid = v.coolifyAppUuid;
  if (!uuid) throw new Stop('manca coolifyAppUuid nello stato: rifare prepara');
  if (!stato.fasi.collaudo?.ok) throw new Stop('manca l\'ok collaudo di Lorenzo nello stato (fasi.collaudo.ok)');

  // A1. PR del sito: deve essere quella collaudata (o già unita)
  const numero = Number(String(v.pr || '').split('/').pop());
  if (!numero) throw new Stop('PR del sito sconosciuta nello stato: rifare prepara');
  let pr = await s.gh.pr(scheda.repo, numero);
  if (!pr.unita) {
    if (!pr.aperta) throw new Stop(`la PR ${pr.url} è chiusa senza merge`);
    if (pr.testa !== v.commitCollaudo) throw new Stop(`la PR ${pr.url} è cambiata dopo il collaudo (${String(pr.testa).slice(0, 7)} invece di ${String(v.commitCollaudo).slice(0, 7)}): rifare collaudo`);
    if (pr.messaggi.some(m => /\[(skip ci|ci skip|no ci|skip actions|actions skip)\]/i.test(m))) throw new Stop(`un commit della PR contiene [skip ci]: lo squash lo copierebbe su main e il rilascio non partirebbe`);
  }
  passo('PR del sito', pr.unita ? `già unita (${String(pr.mergeSha).slice(0, 7)})` : `aperta, testa ${String(pr.testa).slice(0, 7)} = commit collaudato`);

  // A2. Zona del sito ed export prima di ogni modifica (non si sovrascrive mai)
  const zona = await s.cloudflare.zona(scheda.dominio);
  let exp = s.regia.leggi(percorsoExport(scheda));
  if (!exp) {
    exp = { schema: 'zona-export/v1', zona: scheda.dominio, quando: s.ora(), record: await s.cloudflare.tuttiRecord(zona) };
    s.regia.salva(percorsoExport(scheda), exp, `zona: export di ${scheda.dominio} prima del cutover`);
    passo('export della zona', `${exp.record.length} record salvati in ${percorsoExport(scheda)}`);
  } else passo('export della zona', `già salvato il ${exp.quando} (${exp.record.length} record)`);
  const originali = n => exp.record.filter(r => r.nome === n && WEB.includes(r.tipo));
  for (const n of nomiWeb(scheda)) if (!originali(n).length) throw new Stop(`nessun record web per ${n} nell'export: rollback impossibile, nessuna azione`);

  // A3. Variabili richieste e copia delle variabili Production di Vercel sulla risorsa Coolify
  const vars = await s.vercel.variabiliConValori(scheda.vercel.progetto, scheda.vercel.team, 'production');
  const mancanti = (scheda.variabiliRichieste || []).filter(k => !vars.some(x => x.chiave === k));
  if (mancanti.length) throw new Stop(`mancano in Vercel (Production): ${mancanti.join(', ')}. Lorenzo le imposta nel pannello, poi si rilancia cutover`);
  const illeggibili = vars.filter(x => x.valore == null).map(x => x.chiave);
  if (illeggibili.length) throw new Stop(`variabili Vercel "sensitive" non copiabili via API: ${illeggibili.join(', ')}. Vanno rese "encrypted" o messe a mano sulla risorsa Coolify`);
  const daCopiare = vars.filter(x => !/^VERCEL_/.test(x.chiave));
  if (daCopiare.length) await s.coolify.scriviVariabili(uuid, daCopiare);
  const suCoolify = await s.coolify.variabili(uuid);
  for (const e of suCoolify.filter(e => DA_TOGLIERE_SU_COOLIFY.includes(e.chiave))) await s.coolify.cancellaVariabile(uuid, e.uuid);
  const assenti = daCopiare.filter(x => !suCoolify.some(e => e.chiave === x.chiave && !e.preview)).map(x => x.chiave);
  if (assenti.length) throw new Stop(`variabili non presenti sulla risorsa Coolify dopo la copia: ${assenti.join(', ')}`);
  passo('variabili sulla risorsa', `${daCopiare.length} copiate da Vercel Production (${daCopiare.map(x => x.chiave).join(', ')}), valori mai stampati; tolte: ${suCoolify.filter(e => DA_TOGLIERE_SU_COOLIFY.includes(e.chiave)).map(e => e.chiave).join(', ') || 'nessuna'}`);

  // A4. Dominio di backup su Vercel (standby del Worker e verifica-sito): dominio del progetto + CNAME solo DNS
  const bk = scheda.backupDominio;
  if (!(await s.vercel.domini(scheda.vercel.progetto, scheda.vercel.team)).some(d => d.nome === bk)) await s.vercel.aggiungiDominio(scheda.vercel.progetto, scheda.vercel.team, bk);
  const recBk = await s.cloudflare.record(zona, bk);
  if (!recBk.length) await s.cloudflare.creaRecord(zona, { nome: bk, tipo: 'CNAME', contenuto: 'cname.vercel-dns.com', proxied: false, commento: 'backup Vercel (regia migrazioni)' });
  else if (!(recBk.length === 1 && recBk[0].tipo === 'CNAME' && !recBk[0].proxied)) throw new Stop(`record ${bk} già presente ma diverso: ${JSON.stringify(recBk)}`);
  const rb = await finche(s, `https://${bk}/`, r => r.status >= 200 && r.status < 400, { limiteMs: 10 * 60000 });
  if (!(rb.status >= 200 && rb.status < 400)) throw new Stop(`https://${bk}/ non risponde ancora (HTTP ${rb.status}${rb.errore ? `, ${rb.errore}` : ''}): certificato Vercel in emissione? si rilancia tra qualche minuto`);
  passo('dominio di backup', `${bk} su Vercel, HTTP ${rb.status}`);

  // A5. Worker ACME temporaneo (solo se i nomi veri non puntano già alla VPS)
  const giaSuVps = await tuttiSullaVps(s, zona, scheda, config);
  if (!giaSuVps) {
    // Il Worker ACME vede solo il traffico che passa da Cloudflare: i nomi in "solo DNS" verso Vercel
    // vanno messi in proxy (stessa destinazione, nessun cambio per i visitatori) prima delle route.
    await proxyVersoVercel(s, zona, scheda, passo);
    const sempreHttps = await s.cloudflare.impostazione(zona, 'always_use_https');
    if (sempreHttps === 'on') throw new Stop(`"Always Use HTTPS" è attivo sulla zona ${scheda.dominio}: la sfida HTTP-01 non arriverebbe al Worker ACME (runbook D7: va spento)`);
    const orig = await s.cloudflare.record(zona, origineAcme(scheda));
    if (!orig.length) await s.cloudflare.creaA(zona, origineAcme(scheda), config.vpsIp, 'ACME temporaneo (regia migrazioni)');
    else if (!(orig.length === 1 && orig[0].tipo === 'A' && orig[0].contenuto === config.vpsIp)) throw new Stop(`record ${origineAcme(scheda)} già presente ma diverso`);
    await s.cloudflare.caricaWorker(config.cloudflareAccountId, nomeAcme(scheda), codiceAcme(scheda));
    const rotte = await s.cloudflare.rotte(zona);
    for (const schema of rotteAcme(scheda)) {
      const r = rotte.find(x => x.schema === schema);
      if (!r) await s.cloudflare.creaRotta(zona, schema, nomeAcme(scheda));
      else if (r.script !== nomeAcme(scheda)) throw new Stop(`la route ${schema} esiste già con un altro Worker (${r.script})`);
    }
    passo('Worker ACME temporaneo', `${nomeAcme(scheda)} su ${rotteAcme(scheda).join(', ')} (Always Use HTTPS: ${sempreHttps ?? 'non leggibile'})`);
  } else passo('Worker ACME temporaneo', 'non serve: i nomi puntano già alla VPS');

  // A6. Domini veri sulla risorsa (insieme al nome di collaudo), www → dominio, deploy
  const voluti = `https://${scheda.dominioCollaudo},${dominiProduzione(scheda)}`;
  const app = await s.coolify.applicazione(uuid);
  const attuali = String(app.fqdn || '').split(',').filter(Boolean).sort().join(',');
  if (attuali !== voluti.split(',').sort().join(',') || (scheda.www && app.redirect !== 'non-www')) {
    await s.coolify.aggiorna(uuid, { domains: voluti, ...(scheda.www ? { redirect: 'non-www' } : {}) });
    await s.coolify.deploy(uuid);
    passo('domini sulla risorsa', `${voluti}${scheda.www ? ', www → dominio' : ''}; deploy finito`);
  } else {
    await s.coolify.deploy(uuid); // applica le variabili appena copiate
    passo('domini sulla risorsa', 'già impostati; deploy per le variabili finito');
  }

  // A7. Certificati serviti dalla VPS (C5), letti dall'agente
  const nomi = await certificatiOrigine(s, config, scheda, nomiWeb(scheda), 'cutover');
  passo('certificato dall\'origine', `ok per ${nomi.join(', ')}`);

  if (!scheda.ok?.cutover) {
    fase.sospesa = true; fase.attesa = 'ok cutover DNS';
    return `cutover di ${scheda.sito}: preparazione PASS (variabili, backup ${bk}, domini e certificati sulla VPS). Il sito è ancora su Vercel.\nPer il passaggio DNS serve l'ok di Lorenzo: scrivere a Claude "ok cutover DNS".`;
  }
  passo('ok cutover DNS', `di Lorenzo: ${scheda.ok.cutover}`);

  // B1. Primo rilascio di produzione: DOMINIO_OVERRIDE sul nome di collaudo, merge squash della PR
  let mergeSha = pr.unita ? pr.mergeSha : null;
  const registro = async () => { const t = await s.gh.file(scheda.repo, 'release.json', 'rilasci'); return t ? JSON.parse(t) : null; };
  const giaRilasciato = mergeSha && (await registro())?.esito === 'completo' && (await registro())?.commit === mergeSha;
  if (!giaRilasciato && !(await tuttiSullaVps(s, zona, scheda, config))) {
    await s.gh.variabile(scheda.repo, 'DOMINIO_OVERRIDE', scheda.dominioCollaudo);
    if (!pr.unita) {
      if (pr.bozza) await s.gh.prPronta(scheda.repo, numero);
      mergeSha = await s.gh.uniscePr(scheda.repo, numero, { testa: pr.testa, titolo: `Rilascio unico: ${scheda.dominio} sulla VPS (#${numero})` });
      passo('merge della PR', `squash ${mergeSha.slice(0, 7)} su ${scheda.ramo}`);
    }
    const r1 = await rilascio(s, scheda, config, { ramo: scheda.ramo, sha: mergeSha });
    passo('primo rilascio di produzione', `completo su ${scheda.dominioCollaudo} (run ${r1.run.id})`);
  } else passo('primo rilascio di produzione', `già fatto per ${String(mergeSha).slice(0, 7)}`);
  v.cutover.merge = mergeSha;
  const h1 = await finche(s, `https://${scheda.dominioCollaudo}/api/health`, r => revisione(r) === mergeSha, { limiteMs: 3 * 60000 });
  if (revisione(h1) !== mergeSha) throw new Stop(`la VPS non serve ${mergeSha.slice(0, 7)} su ${scheda.dominioCollaudo} (health: ${h1.status} ${revisione(h1) || ''}): DNS non toccato`);

  // B2. Record web verso la VPS, posta intatta. Da qui ogni errore rimette i record dell'export.
  const altriPrima = exp.record.filter(r => !(nomiWeb(scheda).includes(r.nome) && WEB.includes(r.tipo)));
  // Cutover già finito in un giro precedente: non si rifà nulla (e mai un rollback del DNS).
  if (v.cutover.verificato && await tuttiSullaVps(s, zona, scheda, config)) passo('DNS e secondo rilascio', `già fatti (${String(v.cutover.commit).slice(0, 7)} verificato il ${v.cutover.verificato})`);
  else try {
    await cambiaDns(s, zona, scheda, config);
    v.cutover.dns = s.ora();
    passo('DNS verso la VPS', `${nomiWeb(scheda).join(', ')} → A ${config.vpsIp} (proxied)`);
    const ora = await s.cloudflare.tuttiRecord(zona);
    const diversi = altriPrima.filter(r => r.nome !== origineAcme(scheda) && !ora.some(x => x.nome === r.nome && x.tipo === r.tipo && x.contenuto === r.contenuto));
    if (diversi.length) throw new Stop(`record non web cambiati rispetto all'export: ${diversi.map(r => `${r.tipo} ${r.nome}`).join(', ')}`);
    passo('posta e altri record', `identici all'export (${altriPrima.filter(r => r.tipo === 'MX').length} MX)`);

    const h2 = await finche(s, `https://${scheda.dominio}/api/health`, r => revisione(r) === mergeSha, { limiteMs: 5 * 60000 });
    if (revisione(h2) !== mergeSha) throw new Stop(`https://${scheda.dominio}/api/health non serve ${mergeSha.slice(0, 7)} dalla VPS (HTTP ${h2.status})`);
    if (scheda.www) {
      const w = await s.http(`https://www.${scheda.dominio}/`);
      if (!(w.status >= 300 && w.status < 400 && String(w.headers.location || '').startsWith(`https://${scheda.dominio}`))) throw new Stop(`https://www.${scheda.dominio}/ non reindirizza al dominio (HTTP ${w.status} ${w.headers.location || ''})`);
    }
    passo('health sul dominio', `${scheda.dominio} serve ${mergeSha.slice(0, 7)} dalla VPS${scheda.www ? '; www reindirizza' : ''}`);

    // B3. DOMINIO_OVERRIDE tolta, secondo rilascio verificato sul dominio vero
    await s.gh.cancellaVariabile(scheda.repo, 'DOMINIO_OVERRIDE');
    const r2 = await rilascio(s, scheda, config, { ramo: scheda.ramo, lancia: true });
    v.cutover.commit = r2.release.commit;
    passo('secondo rilascio', `completo e verificato su ${scheda.dominio} (run ${r2.run.id})`);

    // B4. verifica-sito dal runner della regia, indipendente dal rilascio
    const r = s.esegui('bash', [join(MODELLI, 'verifica-sito.sh'), scheda.dominio, bk, r2.release.commit],
      { env: { PAGINE: scheda.rilascio.pagine, STAGING: '0' }, silenzioso: true });
    if (r.status !== 0) throw new Stop(`verifica-sito.sh fallita su ${scheda.dominio}: ${(r.stdout || '').split('\n').filter(l => /FAIL|ESITO/.test(l)).slice(-5).join(' | ')}`);
    passo('verifica-sito', `PASS su ${scheda.dominio} (backup ${bk})`);
    v.cutover.verificato = s.ora();
  } catch (e) {
    try { await rimettiDns(s, zona, scheda, exp); passo('ROLLBACK DNS', `record web di ${nomiWeb(scheda).join(', ')} rimessi come nell'export (sito di nuovo su Vercel)`); }
    catch (e2) { throw new Stop(`${e.message}. ROLLBACK DNS FALLITO: ${e2.message}. Rimettere a mano i record da ${percorsoExport(scheda)}`); }
    throw new Stop(`${e.message} (DNS rimesso su Vercel)`);
  }

  // B5. Webhook del CMS: con un secret sbagliato deve rispondere 401 (solo segnalato)
  if (scheda.webhook) {
    const w = await s.http(`https://${scheda.dominio}${scheda.webhook}`, { metodo: 'POST', corpo: JSON.stringify({ secret: 'sbagliato-regia' }), headers: { 'Content-Type': 'application/json' } });
    passo('webhook con secret sbagliato', w.status === 401 ? '401 come atteso' : `AVVISO HTTP ${w.status} (atteso 401)`);
  }

  // B6. Pulizia del Worker ACME temporaneo: i rinnovi ora arrivano direttamente alla VPS
  try { await togliAcme(s, zona, scheda, config); passo('Worker ACME temporaneo', 'tolto (route, script e origin-vps)'); }
  catch (e) { passo('Worker ACME temporaneo', `AVVISO non tolto: ${e.message} (lo ritenta chiudi)`); }

  return `cutover PASS per ${scheda.sito}: https://${scheda.dominio} servito dalla VPS (${String(v.cutover.commit).slice(0, 7)}), Vercel in standby su ${bk}, posta intatta.\nLorenzo: apri il sito nel browser e controlla che tutto vada. Prossimo: fase failover.`;
}

/**
 * Mette in proxy Cloudflare i record web ancora "solo DNS" (stessa destinazione Vercel). Richiede SSL
 * Full o Full (strict), altrimenti Cloudflare parlerebbe in http con Vercel (redirect infinito).
 * Se il sito non risponde più, i record tornano "solo DNS" e la fase si ferma.
 */
export async function proxyVersoVercel(s, zona, scheda, passo) {
  const daCambiare = [];
  for (const n of nomiWeb(scheda)) for (const r of (await s.cloudflare.record(zona, n)).filter(x => WEB.includes(x.tipo) && !x.proxied)) daCambiare.push({ ...r, nome: n });
  if (!daCambiare.length) return;
  const ssl = await s.cloudflare.impostazione(zona, 'ssl');
  if (!['full', 'strict'].includes(ssl)) throw new Stop(`i record web di ${scheda.dominio} sono "solo DNS" e la modalità SSL della zona è "${ssl ?? 'non leggibile'}": per metterli in proxy serve Full o Full (strict)`);
  for (const r of daCambiare) await s.cloudflare.aggiornaRecord(zona, r.id, { nome: r.nome, tipo: r.tipo, contenuto: r.contenuto, proxied: true });
  await s.sleep(20000);
  for (const n of nomiWeb(scheda)) {
    const r = await finche(s, `https://${n}/`, x => x.status >= 200 && x.status < 400, { limiteMs: 2 * 60000 });
    if (!(r.status >= 200 && r.status < 400)) {
      for (const x of daCambiare) await s.cloudflare.aggiornaRecord(zona, x.id, { nome: x.nome, tipo: x.tipo, contenuto: x.contenuto, proxied: false });
      throw new Stop(`con il proxy Cloudflare https://${n}/ risponde HTTP ${r.status}${r.errore ? ` (${r.errore})` : ''}: record rimessi "solo DNS", sito invariato`);
    }
  }
  passo('proxy Cloudflare verso Vercel', `${daCambiare.map(r => `${r.tipo} ${r.nome}`).join(', ')} ora in proxy (SSL ${ssl}), sito ok`);
}

/** true se ogni nome web ha esattamente un record A verso la VPS. */
async function tuttiSullaVps(s, zona, scheda, config) {
  for (const n of nomiWeb(scheda)) {
    const r = (await s.cloudflare.record(zona, n)).filter(x => WEB.includes(x.tipo));
    if (!(r.length === 1 && r[0].tipo === 'A' && r[0].contenuto === config.vpsIp && r[0].proxied)) return false;
  }
  return true;
}

/** Ogni nome web → un solo A verso la VPS (proxied). Il primo record si modifica in place, gli altri si cancellano. */
export async function cambiaDns(s, zona, scheda, config) {
  for (const n of nomiWeb(scheda)) {
    const r = (await s.cloudflare.record(zona, n)).filter(x => WEB.includes(x.tipo));
    if (r.length === 1 && r[0].tipo === 'A' && r[0].contenuto === config.vpsIp && r[0].proxied) continue;
    if (!r.length) { await s.cloudflare.creaRecord(zona, { nome: n, tipo: 'A', contenuto: config.vpsIp, proxied: true, commento: 'cutover (regia migrazioni)' }); continue; }
    await s.cloudflare.aggiornaRecord(zona, r[0].id, { nome: n, tipo: 'A', contenuto: config.vpsIp, proxied: true, commento: 'cutover (regia migrazioni)' });
    for (const x of r.slice(1)) await s.cloudflare.cancellaRecord(zona, x.id);
  }
}

/** Record web di nuovo come nell'export (rollback). */
export async function rimettiDns(s, zona, scheda, exp) {
  for (const n of nomiWeb(scheda)) {
    const orig = exp.record.filter(r => r.nome === n && WEB.includes(r.tipo));
    const ora = (await s.cloudflare.record(zona, n)).filter(x => WEB.includes(x.tipo));
    if (ora.length) await s.cloudflare.aggiornaRecord(zona, ora[0].id, orig[0]);
    else await s.cloudflare.creaRecord(zona, orig[0]);
    for (const x of ora.slice(1)) await s.cloudflare.cancellaRecord(zona, x.id);
    for (const o of orig.slice(1)) await s.cloudflare.creaRecord(zona, o);
  }
}

/** Toglie route, script e record del Worker ACME temporaneo (idempotente). */
export async function togliAcme(s, zona, scheda, config) {
  for (const r of (await s.cloudflare.rotte(zona)).filter(r => r.script === nomeAcme(scheda) || rotteAcme(scheda).includes(r.schema))) await s.cloudflare.cancellaRotta(zona, r.id);
  await s.cloudflare.cancellaWorker(config.cloudflareAccountId, nomeAcme(scheda));
  for (const r of await s.cloudflare.record(zona, origineAcme(scheda))) await s.cloudflare.cancellaRecord(zona, r.id);
}
