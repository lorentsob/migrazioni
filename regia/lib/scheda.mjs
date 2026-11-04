// Scheda macchina di un sito: siti/<sito>.json. Qui si controlla la forma; i valori veri
// (repo, progetto Vercel, risorsa) li controllano le fasi leggendo i servizi.
export const FASI = ['nessuna', 'prepara', 'collaudo', 'cutover', 'failover', 'chiudi'];
export const SCHEMA = 'sito/v1';
const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;
const DOMINIO = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UUID = /^[a-z0-9]{20,40}$/;

export class SchedaNonValida extends Error { constructor(m) { super(m); this.name = 'SchedaNonValida'; } }

export function validaScheda(s, config = {}) {
  const err = m => { throw new SchedaNonValida(`scheda: ${m}`); };
  if (!s || typeof s !== 'object') err('non è un oggetto JSON');
  if (s.schema !== SCHEMA) err(`schema deve essere "${SCHEMA}"`);
  if (!SLUG.test(s.sito || '')) err('sito: slug minuscolo (es. lorenzoboschi)');
  if (!FASI.includes(s.fase)) err(`fase: una tra ${FASI.join(', ')}`);
  if (!REPO.test(s.repo || '')) err('repo: owner/nome');
  if (!DOMINIO.test(s.dominio || '')) err('dominio non valido');
  if (typeof s.www !== 'boolean') err('www: true o false');
  if (s.backupDominio != null && !DOMINIO.test(s.backupDominio)) err('backupDominio non valido');
  if (!s.vercel || !/^prj_[A-Za-z0-9]+$/.test(s.vercel.progetto || '')) err('vercel.progetto: id prj_…');
  if (s.vercel.team != null && !/^team_[A-Za-z0-9]+$/.test(s.vercel.team)) err('vercel.team: id team_…');
  if (typeof s.statico !== 'boolean') err('statico: true o false (true = nessuna connessione in uscita)');
  const c = s.coolify || {};
  if (c.progetto != null && !SLUG.test(c.progetto)) err('coolify.progetto: slug');
  if (c.nome != null && !SLUG.test(c.nome)) err('coolify.nome: slug');
  if (c.riferimento != null && !UUID.test(c.riferimento)) err('coolify.riferimento: uuid');
  const r = s.rilascio || {};
  if (r.pagine != null && !/^(\/[A-Za-z0-9._\/-]*)( \/[A-Za-z0-9._\/-]*)*$/.test(r.pagine)) err('rilascio.pagine: percorsi separati da spazio');
  if (r.immagineDiProva != null && !/^\/[A-Za-z0-9._\/-]+$/.test(r.immagineDiProva)) err('rilascio.immagineDiProva: percorso');
  if (r.node != null && !/^\d+\.\d+\.\d+$/.test(r.node)) err('rilascio.node: versione completa (es. 22.18.0)');
  if (r.contestoExtra != null && !/^[A-Za-z0-9._\/ -]*$/.test(r.contestoExtra)) err('rilascio.contestoExtra: nomi separati da spazio');
  if (s.ok != null && typeof s.ok !== 'object') err('ok: oggetto {collaudo, cutover} con le date degli ok di Lorenzo');
  if (s.ok?.cutover != null && typeof s.ok.cutover !== 'string') err('ok.cutover: data e testo dell\'ok di Lorenzo (stringa)');
  if (s.variabiliRichieste != null && !(Array.isArray(s.variabiliRichieste) && s.variabiliRichieste.every(k => /^[A-Z][A-Z0-9_]*$/.test(k)))) err('variabiliRichieste: nomi di variabili Vercel');
  if (s.sblocco != null && !(typeof s.sblocco === 'object' && ['ripristina', 'accetta', 'completa-vercel'].includes(s.sblocco.azione)
    && typeof s.sblocco.ok === 'string' && s.sblocco.ok && typeof s.sblocco.run === 'string' && /^\d+$/.test(s.sblocco.run)))
    err('sblocco: {azione: ripristina|accetta|completa-vercel, run: id del run fermo, ok: data e testo dell\'ok di Lorenzo}');
  if (s.webhook != null && !/^\/[A-Za-z0-9._\/-]+$/.test(s.webhook)) err('webhook: percorso (es. /api/revalidate)');
  return completa(s, config);
}

/** Valori derivati, con i default: tutto ciò che le fasi usano sta qui, calcolato una volta. */
export function completa(s, config = {}) {
  const owner = s.repo.split('/')[0].toLowerCase(), nome = s.repo.split('/')[1].toLowerCase();
  const zona = config.zonaCollaudo || 'lorentso.it';
  const dominioCollaudo = `collaudo-${s.sito}.${zona}`;
  if (/^(stage-|pr-)/.test(dominioCollaudo)) throw new SchedaNonValida('nome di collaudo riservato dal proxy');
  return {
    ...s,
    ramo: s.ramo || 'main',
    backupDominio: s.backupDominio || `backup.${s.dominio}`,
    dominioCollaudo,
    aliasCollaudo: `${s.sito}-collaudo-${owner}.vercel.app`,
    vercel: { team: config.vercelTeam, ...s.vercel },
    coolify: { progetto: s.sito, nome: `${s.sito}-img`, riferimento: config.coolifyRiferimento, ...(s.coolify || {}) },
    rilascio: { pagine: '/', immagineDiProva: '/favicon.ico', contestoExtra: '', node: '24.22.1', immagine: `ghcr.io/${owner}/${nome}`, ...(s.rilascio || {}) },
    worker: { nome: `${s.sito}-failover`, ...(s.worker || {}) },
    ramoCodice: config.ramoCodice || 'collaudo/rilascio-unico',
  };
}

/** Domini da mettere sulla risorsa al cutover (https://…, separati da virgola, come vuole Coolify). */
export function dominiProduzione(s) {
  return [s.dominio, ...(s.www ? [`www.${s.dominio}`] : [])].map(d => `https://${d}`).join(',');
}
