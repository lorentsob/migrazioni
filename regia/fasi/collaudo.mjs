// Fase "collaudo": prerequisiti del codice sul ramo, rilascio in modalità collaudo (workflow del
// sito lanciato sul ramo collaudo/**), verifica-sito dal runner, certificato dall'origine
// tramite l'agente VPS, poi avviso a Lorenzo con il link. L'ok ("ok collaudo") arriva a Claude.
import { Stop } from '../lib/servizi.mjs';
import { PREREQUISITI_CODICE, MODELLI } from '../lib/modelli.mjs';
import { join } from 'node:path';

export async function collaudo(scheda, s, { env, config, stato, fase }) {
  const passo = (nome, esito) => { fase.passi.push({ nome, esito, quando: s.ora() }); s.log(`${nome}: ${esito}`); };
  const v = stato.valori;
  if (!v.coolifyAppUuid) throw new Stop('manca coolifyAppUuid nello stato: rifare prepara');

  // 1. Ramo del codice e prerequisiti C2
  const testa = await s.gh.ramo(scheda.repo, scheda.ramoCodice);
  if (!testa) throw new Stop(`ramo ${scheda.ramoCodice} assente in ${scheda.repo}`);
  const albero = await s.gh.albero(scheda.repo, testa);
  const leggi = p => s.gh.file(scheda.repo, p, testa);
  const mancanti = [];
  for (const p of PREREQUISITI_CODICE) if (!(await p.verifica(albero, leggi))) mancanti.push(p.nome);
  if (mancanti.length) throw new Stop(`prerequisiti del codice mancanti sul ramo ${scheda.ramoCodice}: ${mancanti.join('; ')}`);
  passo('prerequisiti del codice', `ok su ${testa.slice(0, 7)}`);

  // 2. Registro di collaudo: se fermo si cancella (è un registro di prova), poi rilascio per la testa del ramo
  // Un rilascio già partito (per esempio dal push del ramo) si aspetta: il suo registro non va
  // cancellato mentre lavora, e se finisce bene per la testa del ramo non si rilascia di nuovo.
  const inCorso = async () => (await s.gh.runDelRamo(scheda.repo, 'rilascio-unico.yml', scheda.ramoCodice)).filter(r => r.stato !== 'completed');
  if ((await inCorso()).length) {
    const limite = Date.now() + config.attesaRilascioMinuti * 60000;
    while ((await inCorso()).length) {
      if (Date.now() > limite) throw new Stop(`un rilascio sul ramo ${scheda.ramoCodice} è ancora in corso dopo ${config.attesaRilascioMinuti} minuti`);
      await s.sleep(30000);
    }
    passo('rilascio già in corso', 'atteso fino alla fine');
  }
  const ramoRegistro = 'rilasci-collaudo';
  const leggiRegistro = async () => { const t = await s.gh.file(scheda.repo, 'release.json', ramoRegistro); return t ? JSON.parse(t) : null; };
  let release = await leggiRegistro();
  if (release && release.esito !== 'completo') {
    await s.gh.cancellaRamo(scheda.repo, ramoRegistro);
    passo('registro di collaudo', `era "${release.esito}" (${String(release.commit).slice(0, 7)}): ramo ${ramoRegistro} cancellato, si riparte`);
    release = null;
  }
  if (release?.commit === testa) passo('rilascio di collaudo', `già fatto per ${testa.slice(0, 7)} (run ${release.runId})`);
  else {
    const prima = (await s.gh.runDelRamo(scheda.repo, 'rilascio-unico.yml', scheda.ramoCodice)).map(r => r.id);
    await s.gh.lanciaWorkflow(scheda.repo, 'rilascio-unico.yml', scheda.ramoCodice);
    const fine = Date.now() + config.attesaRilascioMinuti * 60000; let run = null;
    while (Date.now() < fine) {
      const runs = await s.gh.runDelRamo(scheda.repo, 'rilascio-unico.yml', scheda.ramoCodice);
      run = runs.find(r => !prima.includes(r.id)) || null;
      if (run && run.stato === 'completed') break;
      await s.sleep(30000);
    }
    if (!run) throw new Stop('il rilascio di collaudo non è partito (gh workflow run)');
    if (run.stato !== 'completed') throw new Stop(`rilascio di collaudo ancora in corso dopo ${config.attesaRilascioMinuti} minuti: ${run.url}`);
    release = await leggiRegistro();
    if (run.esito !== 'success') throw new Stop(`rilascio di collaudo ${run.esito}: ${run.url}${release && release.esito !== 'completo' ? ` (registro "${release.esito}": ${release.motivo})` : ' (fermo prima della promozione, nulla promosso)'}`);
    if (!release || release.commit !== testa || release.esito !== 'completo') throw new Stop(`run riuscito ma registro non completo per ${testa.slice(0, 7)}`);
    passo('rilascio di collaudo', `completo, run ${run.id}`);
  }
  v.commitCollaudo = testa; v.runCollaudo = release.runId;

  // 3. verifica-sito dal runner della regia (indipendente dal passo 7 del rilascio)
  const bypass = await s.vercel.bypass(scheda.vercel.progetto, scheda.vercel.team); // quello del progetto, mai stampato
  const r = s.esegui('bash', [join(MODELLI, 'verifica-sito.sh'), scheda.dominioCollaudo, scheda.aliasCollaudo, testa],
    { env: { STAGING: '1', PAGINE: scheda.rilascio.pagine, VERCEL_AUTOMATION_BYPASS_SECRET: bypass.secret }, silenzioso: true });
  if (r.status !== 0) throw new Stop(`verifica-sito.sh fallita su ${scheda.dominioCollaudo}: ${(r.stdout || '').split('\n').filter(l => /FAIL|ESITO/.test(l)).slice(-5).join(' | ')}`);
  passo('verifica-sito', `PASS su ${scheda.dominioCollaudo} (backup ${scheda.aliasCollaudo})`);

  // 4. Certificato dall'origine, letto dall'agente VPS
  const id = `${scheda.sito}-collaudo-certificato-${testa.slice(0, 7)}`;
  const registro = s.regia.leggi('vps/registro.json') || { schema: 'vps-registro/v1', risorse: [], verifiche: [] };
  registro.verifiche = registro.verifiche || [];
  if (!registro.verifiche.some(x => x.id === id)) {
    registro.verifiche.push({ id, tipo: 'certificato', dominio: scheda.dominioCollaudo, richiesto: s.ora(), scade: new Date(Date.now() + 30 * 60000).toISOString() });
    s.regia.salva('vps/registro.json', registro, `vps: verifica certificato ${scheda.dominioCollaudo}`);
  }
  const cert = await s.regia.attendi(`vps/esiti/${id}.json`, e => ['PASS', 'FAIL'].includes(e.esito), { limiteMs: config.attesaAgenteMinuti * 60000 });
  if (!cert) throw new Stop(`l'agente VPS non ha risposto alla verifica del certificato entro ${config.attesaAgenteMinuti} minuti`);
  if (cert.esito !== 'PASS') throw new Stop(`certificato dall'origine per ${scheda.dominioCollaudo}: ${cert.dettagli}`);
  passo('certificato dall\'origine', `ok (${cert.dettagli})`);
  const reg2 = s.regia.leggi('vps/registro.json'); reg2.verifiche = (reg2.verifiche || []).filter(x => x.id !== id);
  s.regia.salva('vps/registro.json', reg2, `vps: verifica ${id} letta`);

  fase.attesa = 'ok collaudo';
  return `collaudo PASS per ${scheda.sito} (${testa.slice(0, 7)}): https://${scheda.dominioCollaudo}\nLorenzo: gira il sito (pagine, immagini, Network senza 404), poi scrivi a Claude "ok collaudo ${scheda.sito}".`;
}
