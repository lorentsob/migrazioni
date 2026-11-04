// Fase "chiudi" (procedura v5 C8), dal giorno dopo il cutover: verifica-sito sul dominio,
// certificati dall'origine, poi pulizia di ciò che serviva solo alla migrazione: variabili e rami
// di collaudo (un push su collaudo/** non deve più poter toccare la risorsa di produzione), nome di
// collaudo su Coolify e su Cloudflare, alias Vercel di test, eventuali resti del Worker ACME.
// Log e backup della VPS restano sorvegliati dal bot Telegram "Coolify VPS" (avvisi già attivi).
import { Stop } from '../lib/servizi.mjs';
import { dominiProduzione } from '../lib/scheda.mjs';
import { certificatiOrigine } from '../lib/comuni.mjs';
import { MODELLI } from '../lib/modelli.mjs';
import { togliAcme, nomiWeb } from './cutover.mjs';
import { join } from 'node:path';

export const ORE_MINIME = 18;

export async function chiudi(scheda, s, { env, config, stato, fase }) {
  const passo = (nome, esito) => { fase.passi.push({ nome, esito, quando: s.ora() }); s.log(`${nome}: ${esito}`); };
  const v = stato.valori; const uuid = v.coolifyAppUuid;
  const dns = v.cutover?.dns;
  if (!dns) throw new Stop('cutover senza data del cambio DNS nello stato');
  const ore = (Date.parse(s.ora()) - Date.parse(dns)) / 3600000;
  if (ore < ORE_MINIME) throw new Stop(`chiudi si fa dal giorno dopo il cutover: passate ${ore.toFixed(1)} ore su ${ORE_MINIME}`);

  // 1. Il sito oggi: registro di produzione e verifica-sito
  const t = await s.gh.file(scheda.repo, 'release.json', 'rilasci');
  const release = t ? JSON.parse(t) : null;
  if (release?.esito !== 'completo') throw new Stop(`registro di produzione non completo (${release?.esito || 'assente'}): sbloccare prima con rilascio-sblocca.yml`);
  const r = s.esegui('bash', [join(MODELLI, 'verifica-sito.sh'), scheda.dominio, scheda.backupDominio, release.commit], { env: { PAGINE: scheda.rilascio.pagine, STAGING: '0' }, silenzioso: true });
  if (r.status !== 0) throw new Stop(`verifica-sito.sh fallita su ${scheda.dominio}: ${(r.stdout || '').split('\n').filter(l => /FAIL|ESITO/.test(l)).slice(-5).join(' | ')}`);
  passo('verifica-sito', `PASS su ${scheda.dominio} (${release.commit.slice(0, 7)})`);
  const nomi = await certificatiOrigine(s, config, scheda, nomiWeb(scheda), 'chiudi');
  passo('certificato dall\'origine', `ok per ${nomi.join(', ')} (rinnovo automatico di Traefik)`);

  // 2. Variabili e rami di collaudo nel repo del sito
  for (const n of ['DOMINIO_OVERRIDE', 'DOMINIO_COLLAUDO', 'VERCEL_ALIAS_TEST']) await s.gh.cancellaVariabile(scheda.repo, n);
  for (const b of [v.ramoCodice || scheda.ramoCodice, 'rilasci-collaudo']) await s.gh.cancellaRamo(scheda.repo, b);
  passo('pulizia del repo', `variabili di collaudo tolte; rami ${v.ramoCodice || scheda.ramoCodice} e rilasci-collaudo cancellati`);

  // 3. Nome di collaudo: via dalla risorsa Coolify e dalla zona lorentso.it; alias Vercel di test
  const app = await s.coolify.applicazione(uuid);
  if (String(app.fqdn || '').includes(scheda.dominioCollaudo)) {
    await s.coolify.aggiorna(uuid, { domains: dominiProduzione(scheda) });
    await s.coolify.deploy(uuid);
    passo('nome di collaudo su Coolify', `tolto; domini ${dominiProduzione(scheda)}`);
  } else passo('nome di collaudo su Coolify', 'già tolto');
  const zc = await s.cloudflare.zona(config.zonaCollaudo);
  for (const x of await s.cloudflare.record(zc, scheda.dominioCollaudo)) await s.cloudflare.cancellaRecord(zc, x.id);
  if (v.aliasCollaudo) await s.vercel.cancellaAlias(v.aliasCollaudo, scheda.vercel.team);
  passo('collaudo su DNS e Vercel', `record ${scheda.dominioCollaudo} e alias ${v.aliasCollaudo || '-'} tolti`);

  // 4. Resti del Worker ACME temporaneo (di solito già tolti dal cutover)
  await togliAcme(s, await s.cloudflare.zona(scheda.dominio), scheda, config);
  passo('Worker ACME temporaneo', 'nessun resto');

  // 5. Il sito risponde ancora dopo la pulizia
  const h = await s.http(`https://${scheda.dominio}/api/health`);
  if (h.status !== 200) throw new Stop(`dopo la pulizia /api/health → HTTP ${h.status}`);
  passo('health finale', 'ok');

  return `chiudi PASS per ${scheda.sito}: migrazione finita. ${scheda.dominio} sulla VPS, Vercel in standby su ${scheda.backupDominio}, collaudo ripulito.\nDa qui ogni push su ${scheda.ramo} del sito è un rilascio unico.`;
}
