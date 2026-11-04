// Servizi finti per le fasi: registrano le chiamate e rispondono con un "mondo" modificabile.
export const SCHEDA = {
  schema: 'sito/v1', sito: 'esempio', fase: 'prepara', repo: 'lorentsob/esempio', dominio: 'esempio.it', www: true,
  vercel: { progetto: 'prj_abc123' }, statico: false, rilascio: { pagine: '/it /en', node: '22.18.0' },
};
export const CONFIG = { coolifyUrl: 'https://coolify.test', vpsIp: '10.0.0.1', zonaCollaudo: 'lorentso.it', cloudflareAccountId: 'acc1',
  vercelTeam: 'team_x', coolifyRiferimento: 'rifuuid00000000000000000', ramoCodice: 'collaudo/rilascio-unico', attesaAgenteMinuti: 1, attesaRilascioMinuti: 1 };
export const ENV = { MIGRAZIONI_GH_TOKEN: 'ghtok', VERCEL_TOKEN: 'v', COOLIFY_TOKEN: 'c', CF_ACCESS_CLIENT_ID: 'i', CF_ACCESS_CLIENT_SECRET: 's',
  TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1', CLOUDFLARE_WORKERS_TOKEN: 'cf', VERCEL_AUTOMATION_BYPASS_SECRET: 'byp', GITHUB_RUN_ID: '77' };

export function serviziFinti(mondo = {}) {
  const m = {
    rami: { 'lorentsob/esempio': { main: 'a'.repeat(40) } }, file: {}, alberi: {}, segreti: [], variabili: {}, pr: null,
    vercelProgetto: { name: 'esempio', framework: 'nextjs', link: { org: 'lorentsob', repo: 'esempio' }, protectionBypass: {} },
    vercelEnv: { production: ['A', 'B'], preview: ['A', 'B'] },
    coolifyApp: [], record: [], regiaFile: {}, remoto: {}, runs: [], esecuzioni: [], avvisi: [], ...mondo,
  };
  const chiamate = [];
  const reg = (n, ...a) => chiamate.push([n, ...a]);
  let t = 0; const ora = () => `2026-11-04T10:00:${String(t++).padStart(2, '0')}Z`;
  const s = {
    mondo: m, chiamate, ora, log: () => {}, sleep: () => new Promise(r => setImmediate(r)), avvisa: async x => { m.avvisi.push(x); return true; },
    esegui: (cmd, args, opt) => { reg('esegui', cmd, args[0]); m.esecuzioni.push([cmd, ...args]); return m.esitoEsegui || { status: 0, stdout: 'ESITO PASS\n' }; },
    gh: {
      async repo(r) { reg('gh.repo', r); if (m.repoAssente) { const e = new Error('GitHub repo -> HTTP 404'); throw e; } return { default_branch: 'main' }; },
      async ramo(r, b) { reg('gh.ramo', r, b); return m.rami[r]?.[b] ?? null; },
      async file(r, p, ref) { reg('gh.file', p, ref); return m.file[p] ?? null; },
      async albero(r, ref) { reg('gh.albero', ref); return new Set(m.alberi[ref] || []); },
      async cancellaRamo(r, b) { reg('gh.cancellaRamo', b); delete m.rami[r]?.[b]; delete m.file['release.json']; },
      async segreto(r, n, v) { reg('gh.segreto', n, v ? 'valore' : 'VUOTO'); if (!v) throw new Error(`segreto ${n}: valore vuoto`); m.segreti.push(n); },
      async variabile(r, n, v) { reg('gh.variabile', n, v); m.variabili[n] = v; },
      async nomiSegreti() { return [...m.segreti]; },
      async variabili() { return { ...m.variabili }; },
      async prAperta(r, b) { reg('gh.prAperta', b); return m.pr; },
      async apriPr(r, o) { reg('gh.apriPr', o.testa, o.base); m.pr = { numero: 5, url: 'https://github.com/lorentsob/esempio/pull/5' }; return m.pr; },
      async scriviFile(r, o) { reg('gh.scriviFile', o.ramo, o.file.map(f => f.percorso)); m.rami[r][o.ramo] = m.rami[r][o.ramo] || 'b'.repeat(40); return { commit: m.rami[r][o.ramo], cambiato: true }; },
      async lanciaWorkflow(r, w, ref, input) { reg('gh.lanciaWorkflow', w, ref, ...(input ? [input] : [])); if (m.alLancio) m.alLancio(m, w, input); },
      async runDelRamo(r, w, b) { reg('gh.runDelRamo', b); return w === 'rilascio-sblocca.yml' ? (m.runsSblocca || []) : m.runs; },
      async cancellaVariabile(r, n) { reg('gh.cancellaVariabile', n); delete m.variabili[n]; },
      async pr(r, n) { reg('gh.pr', n); return structuredClone(m.prDettaglio); },
      async prPronta(r, n) { reg('gh.prPronta', n); m.prDettaglio.bozza = false; },
      async uniscePr(r, n, o) { reg('gh.uniscePr', n, o.testa); m.prDettaglio.unita = true; m.prDettaglio.aperta = false; m.prDettaglio.mergeSha = m.mergeSha; if (m.alMerge) m.alMerge(m); return m.mergeSha; },
    },
    vercel: {
      async progetto(id, team) { reg('vercel.progetto', id, team); return m.vercelProgetto; },
      async bypass(id) { reg('vercel.bypass', id); const k = Object.keys(m.vercelProgetto.protectionBypass); return k.length ? { secret: k[0], nuovo: false } : { secret: 'nuovosegreto', nuovo: true }; },
      async nomiVariabili() { return { production: new Set(m.vercelEnv.production), preview: new Set(m.vercelEnv.preview) }; },
      async variabiliConValori() { reg('vercel.variabiliConValori'); return structuredClone(m.vercelValori || []); },
      async domini() { return (m.vercelDomini || []).map(nome => ({ nome, verificato: true })); },
      async aggiungiDominio(id, team, nome) { reg('vercel.aggiungiDominio', nome); (m.vercelDomini ||= []).push(nome); },
      async cancellaAlias(a) { reg('vercel.cancellaAlias', a); },
    },
    coolify: {
      async applicazioni() { reg('coolify.applicazioni'); return m.coolifyApp; },
      async applicazione(u) { reg('coolify.applicazione', u); return { uuid: u, destination: { uuid: 'dest1' }, ...(m.coolifyDettaglio || {}) }; },
      async aggiorna(u, c) { reg('coolify.aggiorna', u, c); m.coolifyDettaglio = { ...(m.coolifyDettaglio || {}), ...(c.domains ? { fqdn: c.domains } : {}), ...(c.redirect ? { redirect: c.redirect } : {}) }; },
      async variabili() { return structuredClone(m.coolifyEnv || []); },
      async scriviVariabili(u, coppie) { reg('coolify.scriviVariabili', coppie.map(c => c.chiave)); for (const c of coppie) if (!(m.coolifyEnv ||= []).some(e => e.chiave === c.chiave)) m.coolifyEnv.push({ uuid: `e-${c.chiave}`, chiave: c.chiave, preview: false }); },
      async cancellaVariabile(u, e) { reg('coolify.cancellaVariabile', e); m.coolifyEnv = m.coolifyEnv.filter(x => x.uuid !== e); },
      async progettoUuid(n) { reg('coolify.progettoUuid', n); return 'prog1'; },
      async serverUuid() { return 'srv1'; },
      async creaRisorsaImmagine(o) { reg('coolify.crea', o.nome, o.dominio); m.coolifyApp.push({ uuid: 'nuovouuid0000000000000000', name: o.nome, fqdn: o.dominio }); return 'nuovouuid0000000000000000'; },
      async domini(u, d) { reg('coolify.domini', u, d); },
      async deploy(u) { reg('coolify.deploy', u); return 'dep1'; },
    },
    cloudflare: {
      async zona(n) { reg('cf.zona', n); return 'zona1'; },
      async record(z, n) { reg('cf.record', n); return m.dns ? m.dns.filter(r => r.nome === n).map(r => ({ ...r })) : m.record; },
      async creaA(z, n, ip) { reg('cf.creaA', n, ip); if (m.dns) m.dns.push({ id: `id${m.dns.length + 100}`, nome: n, tipo: 'A', contenuto: ip, proxied: true }); else m.record.push({ id: 'r1', tipo: 'A', contenuto: ip, proxied: true }); },
      async tuttiRecord() { reg('cf.tuttiRecord'); return structuredClone(m.dns); },
      async creaRecord(z, r) { reg('cf.creaRecord', r.nome, r.tipo, r.contenuto); const id = `id${m.dns.length + 100}`; m.dns.push({ ...r, id }); return id; },
      async aggiornaRecord(z, id, r) { reg('cf.aggiornaRecord', r.nome, r.tipo, r.contenuto); const i = m.dns.findIndex(x => x.id === id); m.dns[i] = { ...m.dns[i], tipo: r.tipo, contenuto: r.contenuto, proxied: r.proxied }; if (m.alDns) m.alDns(m); },
      async cancellaRecord(z, id) { reg('cf.cancellaRecord', id); m.dns = m.dns.filter(x => x.id !== id); },
      async impostazione(z, n) { return (m.impostazioni || {})[n] ?? null; },
      async rotte() { return structuredClone(m.rotte || []); },
      async creaRotta(z, schema, script) { reg('cf.creaRotta', schema, script); (m.rotte ||= []).push({ id: `ro${m.rotte.length}`, schema, script }); },
      async cancellaRotta(z, id) { reg('cf.cancellaRotta', id); m.rotte = m.rotte.filter(r => r.id !== id); },
      async caricaWorker(a, nome) { reg('cf.caricaWorker', nome); },
      async cancellaWorker(a, nome) { reg('cf.cancellaWorker', nome); },
    },
    http: async (url, o = {}) => { reg('http', url, o.metodo || 'GET'); return m.http ? m.http(url, o, m) : { status: 200, headers: {}, testo: '{}' }; },
    regia: {
      leggi: p => { reg('regia.leggi', p); return m.regiaFile[p] ? structuredClone(m.regiaFile[p]) : null; },
      salva: (p, o, msg) => { reg('regia.salva', p, msg); m.regiaFile[p] = structuredClone(o); if (m.alSalva) m.alSalva(p, o, m); return true; },
      leggiRemoto: p => m.remoto[p] ?? null,
      async attendi(p, cond) { reg('regia.attendi', p); const e = m.remoto[p]; return e && cond(e) ? e : null; },
    },
  };
  return s;
}
