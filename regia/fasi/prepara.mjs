// Fase "prepara": controlla repo e Vercel, record DNS di collaudo, bypass Vercel, secret e
// variabili del sito, risorsa Coolify sul nome di collaudo, registrazione sulla VPS tramite
// l'agente, ramo con i modelli e PR bozza. Idempotente: ogni passo legge prima di scrivere.
// s = servizi {gh, vercel, coolify, cloudflare, regia, avvisa, ora, log}; scheda = siti/<sito>.json completata.
import { Stop } from '../lib/servizi.mjs';
import { fileDelSito } from '../lib/modelli.mjs';

export const SEGRETI_SITO = ['VERCEL_TOKEN', 'COOLIFY_TOKEN', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'CLOUDFLARE_WORKERS_TOKEN'];

export async function prepara(scheda, s, { env, config, stato, fase }) {
  const passo = (nome, esito) => { fase.passi.push({ nome, esito, quando: s.ora() }); s.log(`${nome}: ${esito}`); };
  const v = stato.valori;

  // 1. Repository del sito e progetto Vercel (sola lettura)
  const repo = await s.gh.repo(scheda.repo);
  if (repo.default_branch !== scheda.ramo) throw new Stop(`il ramo principale di ${scheda.repo} è ${repo.default_branch}, la scheda dice ${scheda.ramo}`);
  const testa = await s.gh.ramo(scheda.repo, scheda.ramo);
  passo('repo del sito', `${scheda.repo}@${scheda.ramo} ${testa.slice(0, 7)}`);
  const prog = await s.vercel.progetto(scheda.vercel.progetto, scheda.vercel.team);
  const linkRepo = prog.link?.repo && prog.link?.org ? `${prog.link.org}/${prog.link.repo}` : null;
  if (linkRepo && linkRepo.toLowerCase() !== scheda.repo.toLowerCase()) throw new Stop(`il progetto Vercel è collegato a ${linkRepo}, non a ${scheda.repo}`);
  passo('progetto Vercel', `${prog.name} (${prog.framework || 'framework?'})`);
  const nomi = await s.vercel.nomiVariabili(scheda.vercel.progetto, scheda.vercel.team);
  const mancanti = [...nomi.production].filter(n => !nomi.preview.has(n) && !/^VERCEL_/.test(n));
  v.variabiliPreviewMancanti = mancanti;
  passo('variabili Vercel in Preview', mancanti.length ? `AVVISO mancano in Preview: ${mancanti.join(', ')} (Lorenzo le imposta nel pannello prima del collaudo)` : 'stesse di Production');

  // 2. Record DNS di collaudo (zona lorentso.it)
  const zona = await s.cloudflare.zona(config.zonaCollaudo);
  const record = await s.cloudflare.record(zona, scheda.dominioCollaudo);
  if (record.length === 0) { await s.cloudflare.creaA(zona, scheda.dominioCollaudo, config.vpsIp); passo('record DNS di collaudo', `creato A ${scheda.dominioCollaudo} -> VPS (proxied)`); }
  else if (record.length === 1 && record[0].tipo === 'A' && record[0].contenuto === config.vpsIp && record[0].proxied) passo('record DNS di collaudo', 'già presente');
  else throw new Stop(`record ${scheda.dominioCollaudo} già presente ma diverso: ${JSON.stringify(record)}`);
  v.dominioCollaudo = scheda.dominioCollaudo;

  // 3. Bypass Vercel e secret del repository del sito (copiati dalla regia)
  const bypass = await s.vercel.bypass(scheda.vercel.progetto, scheda.vercel.team);
  passo('bypass Vercel', bypass.nuovo ? 'generato' : 'riusato quello esistente');
  const presenti = new Set(await s.gh.nomiSegreti(scheda.repo));
  await s.gh.segreto(scheda.repo, 'VERCEL_AUTOMATION_BYPASS_SECRET', bypass.secret);
  for (const nome of SEGRETI_SITO) await s.gh.segreto(scheda.repo, nome, env[nome]);
  passo('secret del sito', `${SEGRETI_SITO.length + 1} impostati (${[...presenti].filter(n => SEGRETI_SITO.includes(n)).length} esistevano già)`);
  v.aliasCollaudo = scheda.aliasCollaudo;
  await s.gh.variabile(scheda.repo, 'DOMINIO_COLLAUDO', scheda.dominioCollaudo);
  await s.gh.variabile(scheda.repo, 'VERCEL_ALIAS_TEST', scheda.aliasCollaudo);
  await s.gh.variabile(scheda.repo, 'CLOUDFLARE_ACCOUNT_ID', config.cloudflareAccountId);
  passo('variabili del sito', 'DOMINIO_COLLAUDO, VERCEL_ALIAS_TEST, CLOUDFLARE_ACCOUNT_ID');

  // 4. Risorsa Coolify a immagine sul nome di collaudo (segnaposto whoami)
  const dominioHttps = `https://${scheda.dominioCollaudo}`;
  const app = (await s.coolify.applicazioni()).filter(a => a.name === scheda.coolify.nome);
  let uuid;
  if (app.length === 0) {
    const rif = await s.coolify.applicazione(scheda.coolify.riferimento);
    const dest = rif?.destination?.uuid; if (!dest) throw new Stop('risorsa di riferimento senza destination');
    uuid = await s.coolify.creaRisorsaImmagine({ progetto: await s.coolify.progettoUuid(scheda.coolify.progetto), server: await s.coolify.serverUuid(), destinazione: dest, nome: scheda.coolify.nome, dominio: dominioHttps });
    await s.coolify.deploy(uuid);
    passo('risorsa Coolify', `creata ${uuid} su ${scheda.dominioCollaudo}, deploy del segnaposto finito`);
  } else if (app.length === 1 && String(app[0].fqdn || '').split(',').includes(dominioHttps)) { uuid = app[0].uuid; passo('risorsa Coolify', `già presente ${uuid}`); }
  else throw new Stop(`esiste già una risorsa "${scheda.coolify.nome}" con domini ${app[0]?.fqdn}: nessuna azione`);
  if (!/^[a-z0-9]{20,40}$/.test(uuid)) throw new Stop(`uuid Coolify inatteso: ${uuid}`);
  v.coolifyAppUuid = uuid;
  await s.gh.variabile(scheda.repo, 'COOLIFY_APP_UUID', uuid);

  // 5. Registrazione sulla VPS (policy e backup) tramite l'agente, in modalità pull
  const registro = s.regia.leggi('vps/registro.json') || { schema: 'vps-registro/v1', risorse: [], verifiche: [] };
  const voce = { uuid, sito: scheda.sito, riferimento: scheda.coolify.riferimento, statico: scheda.statico, voluto: 'registrata', richiesto: s.ora() };
  const i = registro.risorse.findIndex(r => r.uuid === uuid);
  if (i >= 0) registro.risorse[i] = { ...registro.risorse[i], ...voce, richiesto: registro.risorse[i].richiesto }; else registro.risorse.push(voce);
  s.regia.salva('vps/registro.json', registro, `vps: registra ${uuid} (${scheda.sito})`);
  const esito = await s.regia.attendi(`vps/esiti/${uuid}.json`, e => e.voluto === 'registrata' && ['PASS', 'FAIL'].includes(e.esito), { limiteMs: config.attesaAgenteMinuti * 60000 });
  if (!esito) throw new Stop(`l'agente VPS non ha risposto entro ${config.attesaAgenteMinuti} minuti: timer oracle-migrazioni attivo?`);
  if (esito.esito !== 'PASS') throw new Stop(`registrazione sulla VPS fallita: ${esito.dettagli || esito.errore}`);
  passo('registrazione VPS', `PASS (${esito.applicato})`);

  // 6. Ramo del codice con i modelli configurati e PR bozza
  const vercelEsistente = await s.gh.file(scheda.repo, 'vercel.json', scheda.ramo);
  const file = await fileDelSito(scheda, { vercelEsistente });
  const scritto = await s.gh.scriviFile(scheda.repo, { ramo: scheda.ramoCodice, base: scheda.ramo, file, messaggio: 'pipeline: modelli del rilascio unico (regia migrazioni)' });
  passo('ramo del codice', `${scheda.ramoCodice} ${scritto.commit.slice(0, 7)}${scritto.cambiato ? '' : ' (nessuna modifica)'}`);
  let pr = await s.gh.prAperta(scheda.repo, scheda.ramoCodice);
  if (!pr) {
    pr = await s.gh.apriPr(scheda.repo, { testa: scheda.ramoCodice, base: scheda.ramo, titolo: `Rilascio unico: ${scheda.dominio} sulla VPS`, corpo: corpoPr(scheda, uuid) });
    passo('PR', `aperta ${pr.url}`);
  } else passo('PR', `già aperta ${pr.url}`);
  v.ramoCodice = scheda.ramoCodice; v.pr = pr.url;

  return `prepara PASS per ${scheda.sito}: risorsa ${uuid} su ${scheda.dominioCollaudo}, PR ${pr.url}. Prossimo: Claude completa il codice (C2) sul ramo ${scheda.ramoCodice}, poi fase collaudo.`;
}

function corpoPr(scheda, uuid) {
  return `Pipeline del rilascio unico per ${scheda.dominio} (procedura v5, Parte B), installata dalla regia \`migrazioni\`.

Risorsa Coolify a immagine: \`${uuid}\` su https://${scheda.dominioCollaudo}.

Da completare nel codice prima del collaudo (C2):
- [ ] \`output: "standalone"\` e \`env.SOURCE_COMMIT\` in \`next.config\`
- [ ] \`/api/health\` con \`{status:"ok", revision}\` e \`no-store\`
- [ ] \`healthcheck.cjs\` nella radice
- [ ] \`VERCEL_ENV\` / \`VERCEL_URL\` sostituiti da variabili proprie
- [ ] webhook CMS autenticato, se c'è un CMS

Il merge si fa solo nella fase cutover, con l'ok di Lorenzo.`;
}
