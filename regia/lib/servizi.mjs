// Servizi usati dalle fasi: GitHub (API contenuti, gh, git), Vercel, Coolify (via Cloudflare
// Access), Cloudflare DNS, Telegram e la regia stessa (file in stato/ e vps/ con commit e push).
// Regole: nessun segreto stampato; ogni scrittura si tenta una volta e poi si rilegge lo stato;
// le attese sono letture ripetute. fetchFn ed esegui sono iniettabili per i test.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

export const sleepReale = ms => new Promise(r => setTimeout(r, ms));

/** Toglie token e credenziali dagli output prima di metterli in un messaggio. */
export const redigi = s => String(s).replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@').replace(/\b(github_pat_|ghp_|ghs_)[A-Za-z0-9_]+/g, '$1***');

export class Stop extends Error { constructor(m, dettagli = null) { super(m); this.name = 'Stop'; this.dettagli = dettagli; } }

export function serve(env, nomi) {
  const mancanti = nomi.filter(n => !env[n]);
  if (mancanti.length) throw new Stop(`segreti o variabili mancanti nella regia: ${mancanti.join(', ')}`);
}

/** esegui reale: comandi esterni (git, gh, bash). Mai stampare args che contengono token. */
export function eseguiReale(cmd, args, { input, cwd, env, silenzioso = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, cwd, env: { ...process.env, ...(env || {}) }, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Stop(`${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !silenzioso) throw new Stop(`${cmd} ${args.filter(a => !/token|ghp_|github_pat_/i.test(a)).slice(0, 4).join(' ')} -> exit ${r.status}: ${redigi(r.stderr || r.stdout || '').slice(0, 400)}`);
  return r;
}

async function chiamaJson(fetchFn, nome, url, init = {}) {
  const r = await fetchFn(url, init);
  const testo = await r.text();
  let json = null; try { json = testo ? JSON.parse(testo) : {}; } catch { /* non JSON */ }
  return { ok: r.ok, status: r.status, json, testo, nome };
}
const atteso = (r, cosa) => {
  if (r.ok) return r.json;
  const msg = r.json?.message ?? r.json?.error?.message ?? (r.testo && !r.json ? r.testo : '');
  throw new Stop(`${cosa} -> HTTP ${r.status}${msg ? `: ${String(msg).slice(0, 160)}` : ''}`);
};

// ---------- GitHub (repository del sito) ----------
export function github(env, { fetchFn = fetch, esegui = eseguiReale } = {}) {
  serve(env, ['MIGRAZIONI_GH_TOKEN']);
  const token = env.MIGRAZIONI_GH_TOKEN;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'migrazioni-regia/1' };
  const api = (path, init = {}) => chiamaJson(fetchFn, path, `https://api.github.com${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const ghEnv = { GH_TOKEN: token, GITHUB_TOKEN: token };
  return {
    async repo(repo) { return atteso(await api(`/repos/${repo}`), `GitHub repo ${repo}`); },
    async ramo(repo, ramo) {
      const r = await api(`/repos/${repo}/branches/${encodeURIComponent(ramo)}`);
      if (r.status === 404) return null;
      return atteso(r, `GitHub ramo ${repo}@${ramo}`).commit.sha;
    },
    /** Contenuto di un file (testo) oppure null se assente. */
    async file(repo, percorso, ref) {
      const r = await api(`/repos/${repo}/contents/${percorso}?ref=${encodeURIComponent(ref)}`, { headers: { Accept: 'application/vnd.github.raw' } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Stop(`GitHub file ${repo}:${percorso}@${ref} -> HTTP ${r.status}`);
      return r.testo;
    },
    /** Elenco dei percorsi dell'albero di un ref (ricorsivo). */
    async albero(repo, ref) {
      const j = atteso(await api(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`), `GitHub albero ${repo}@${ref}`);
      return new Set((j.tree || []).filter(t => t.type === 'blob').map(t => t.path));
    },
    async cancellaRamo(repo, ramo) {
      const r = await api(`/repos/${repo}/git/refs/heads/${ramo}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404 && r.status !== 422) throw new Stop(`GitHub cancellazione ramo ${ramo} -> HTTP ${r.status}`);
    },
    async segreto(repo, nome, valore) {
      if (!valore) throw new Stop(`segreto ${nome}: valore vuoto nella regia`);
      esegui('gh', ['secret', 'set', nome, '--repo', repo], { input: valore, env: ghEnv });
    },
    async variabile(repo, nome, valore) { esegui('gh', ['variable', 'set', nome, '--repo', repo, '--body', valore], { env: ghEnv }); },
    async nomiSegreti(repo) {
      const r = esegui('gh', ['secret', 'list', '--repo', repo, '--json', 'name', '--jq', '.[].name'], { env: ghEnv });
      return r.stdout.trim().split('\n').filter(Boolean);
    },
    async variabili(repo) {
      const r = esegui('gh', ['variable', 'list', '--repo', repo, '--json', 'name,value'], { env: ghEnv });
      return Object.fromEntries(JSON.parse(r.stdout || '[]').map(v => [v.name, v.value]));
    },
    /** PR aperta con quel ramo di testa, oppure null. */
    async prAperta(repo, ramo) {
      const owner = repo.split('/')[0];
      const j = atteso(await api(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${ramo}`)}`), `GitHub PR di ${ramo}`);
      return j[0] ? { numero: j[0].number, url: j[0].html_url } : null;
    },
    async apriPr(repo, { testa, base, titolo, corpo, bozza = true }) {
      const j = atteso(await api(`/repos/${repo}/pulls`, { method: 'POST', body: JSON.stringify({ head: testa, base, title: titolo, body: corpo, draft: bozza }) }), 'GitHub apertura PR');
      return { numero: j.number, url: j.html_url };
    },
    /**
     * Scrive (o aggiorna) file su un ramo del repository del sito con un clone poco profondo,
     * un commit e un push. Se il ramo non esiste lo crea dal ramo base. Ritorna lo sha del commit
     * (o quello esistente se non c'era nulla da cambiare).
     */
    async scriviFile(repo, { ramo, base, file, messaggio, cartella = mkdtempSync(join(tmpdir(), 'sito-')) }) {
      const url = `https://x-access-token:${token}@github.com/${repo}.git`;
      const esiste = await this.ramo(repo, ramo);
      esegui('git', ['clone', '--quiet', '--depth', '1', '--branch', esiste ? ramo : base, url, cartella]);
      if (!esiste) esegui('git', ['checkout', '--quiet', '-b', ramo], { cwd: cartella });
      for (const f of file) { const p = join(cartella, f.percorso); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.contenuto); }
      esegui('git', ['add', '-A'], { cwd: cartella });
      const diff = esegui('git', ['diff', '--cached', '--quiet'], { cwd: cartella, silenzioso: true });
      if (diff.status === 0 && esiste) return { commit: esiste, cambiato: false };
      if (diff.status !== 0) esegui('git', ['-c', 'user.name=regia-migrazioni', '-c', 'user.email=regia@lorentso.it', 'commit', '--quiet', '-m', messaggio], { cwd: cartella });
      esegui('git', ['push', '--quiet', '-u', 'origin', ramo], { cwd: cartella });
      return { commit: esegui('git', ['rev-parse', 'HEAD'], { cwd: cartella }).stdout.trim(), cambiato: diff.status !== 0 };
    },
    async lanciaWorkflow(repo, workflow, ref) { esegui('gh', ['workflow', 'run', workflow, '--repo', repo, '--ref', ref], { env: ghEnv }); },
    async cancellaVariabile(repo, nome) {
      const r = await api(`/repos/${repo}/actions/variables/${nome}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Stop(`GitHub cancellazione variabile ${nome} -> HTTP ${r.status}`);
    },
    /** Stato di una PR: {numero, url, aperta, bozza, unita, mergeSha, testa, messaggi[]} (messaggi dei commit). */
    async pr(repo, numero) {
      const j = atteso(await api(`/repos/${repo}/pulls/${numero}`), `GitHub PR ${numero}`);
      const c = atteso(await api(`/repos/${repo}/pulls/${numero}/commits?per_page=100`), `GitHub commit della PR ${numero}`);
      return { numero: j.number, url: j.html_url, aperta: j.state === 'open', bozza: !!j.draft, unita: !!j.merged, mergeSha: j.merge_commit_sha,
        testa: j.head?.sha, ramo: j.head?.ref, messaggi: c.map(x => x.commit?.message || '') };
    },
    async prPronta(repo, numero) { esegui('gh', ['pr', 'ready', String(numero), '--repo', repo], { env: ghEnv }); },
    /** Merge squash con controllo della testa: GitHub rifiuta se la PR è cambiata. Ritorna lo sha su main. */
    async uniscePr(repo, numero, { testa, titolo }) {
      const j = atteso(await api(`/repos/${repo}/pulls/${numero}/merge`, { method: 'PUT', body: JSON.stringify({ merge_method: 'squash', sha: testa, commit_title: titolo }) }), `GitHub merge PR ${numero}`);
      if (!j.merged) throw new Stop(`GitHub: merge della PR ${numero} non fatto: ${j.message}`);
      return j.sha;
    },
    async runDelRamo(repo, workflow, ramo) {
      const j = atteso(await api(`/repos/${repo}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(ramo)}&per_page=10`), 'GitHub run');
      return (j.workflow_runs || []).map(r => ({ id: r.id, sha: r.head_sha, stato: r.status, esito: r.conclusion, evento: r.event, creato: r.created_at, url: r.html_url }));
    },
  };
}

// ---------- Vercel ----------
export function vercel(env, { fetchFn = fetch } = {}) {
  serve(env, ['VERCEL_TOKEN']);
  const h = { Authorization: `Bearer ${env.VERCEL_TOKEN}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  const api = (path, team, init = {}) => chiamaJson(fetchFn, path, `https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(team)}`, { ...init, headers: h });
  return {
    async progetto(id, team) { return atteso(await api(`/v9/projects/${encodeURIComponent(id)}`, team), `Vercel progetto ${id}`); },
    /** Secret di bypass già esistente (il primo "automation-bypass") oppure uno nuovo generato. */
    async bypass(id, team) {
      const p = await this.progetto(id, team);
      const esistenti = Object.entries(p.protectionBypass || {}).filter(([, v]) => v?.scope === 'automation-bypass').map(([k]) => k);
      if (esistenti.length) return { secret: esistenti[0], nuovo: false };
      const j = atteso(await api(`/v1/projects/${encodeURIComponent(id)}/protection-bypass`, team, { method: 'PATCH', body: JSON.stringify({ generate: { note: 'regia migrazioni' } }) }), 'Vercel bypass');
      const nuovi = Object.entries(j.protectionBypass || {}).filter(([, v]) => v?.scope === 'automation-bypass').map(([k]) => k);
      if (!nuovi.length) throw new Stop('Vercel: bypass generato ma non letto');
      return { secret: nuovi[0], nuovo: true };
    },
    /** Nomi delle variabili per ambiente (mai i valori). */
    async nomiVariabili(id, team) {
      const j = atteso(await api(`/v9/projects/${encodeURIComponent(id)}/env`, team), 'Vercel variabili');
      const per = { production: new Set(), preview: new Set() };
      for (const e of j.envs || []) for (const t of e.target || []) if (per[t]) per[t].add(e.key);
      return per;
    },
    /**
     * Variabili di un ambiente con i valori in chiaro, per copiarle altrove (mai stampate).
     * [{chiave, valore, tipo}]; valore null per le "sensitive" (Vercel non le restituisce).
     */
    async variabiliConValori(id, team, ambiente = 'production') {
      const j = atteso(await api(`/v9/projects/${encodeURIComponent(id)}/env`, team), 'Vercel variabili');
      const out = [];
      for (const e of (j.envs || []).filter(e => (e.target || []).includes(ambiente) && !e.gitBranch && e.type !== 'system')) {
        if (e.type === 'sensitive') { out.push({ chiave: e.key, valore: null, tipo: e.type }); continue; }
        const d = atteso(await api(`/v1/projects/${encodeURIComponent(id)}/env/${encodeURIComponent(e.id)}`, team), `Vercel variabile ${e.key}`);
        out.push({ chiave: e.key, valore: typeof d.value === 'string' ? d.value : null, tipo: e.type });
      }
      return out;
    },
    async domini(id, team) {
      const j = atteso(await api(`/v9/projects/${encodeURIComponent(id)}/domains?limit=100`, team), 'Vercel domini');
      return (j.domains || []).map(d => ({ nome: d.name, verificato: !!d.verified, redirect: d.redirect || null }));
    },
    async aggiungiDominio(id, team, nome) {
      return atteso(await api(`/v10/projects/${encodeURIComponent(id)}/domains`, team, { method: 'POST', body: JSON.stringify({ name: nome }) }), `Vercel aggiunta dominio ${nome}`);
    },
    async cancellaAlias(alias, team) {
      const g = await api(`/v4/aliases/${encodeURIComponent(alias)}`, team);
      if (g.status === 404) return;
      const uid = atteso(g, `Vercel alias ${alias}`).uid;
      const r = await api(`/v2/aliases/${encodeURIComponent(uid)}`, team, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Stop(`Vercel cancellazione alias ${alias} -> HTTP ${r.status}`);
    },
  };
}

// ---------- Coolify ----------
export function coolify(env, config, { fetchFn = fetch, sleep = sleepReale, attesaMs = 6000 } = {}) {
  serve(env, ['COOLIFY_TOKEN', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET']);
  const base = `${config.coolifyUrl}/api/v1`;
  const h = { 'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET, Authorization: `Bearer ${env.COOLIFY_TOKEN}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  const api = async (path, init = {}) => atteso(await chiamaJson(fetchFn, path, `${base}${path}`, { ...init, headers: h }), `Coolify ${init.method || 'GET'} ${path}`);
  return {
    applicazioni: () => api('/applications'),
    applicazione: uuid => api(`/applications/${uuid}`),
    async progettoUuid(nome) {
      const p = (await api('/projects')).find(x => x.name === nome);
      if (p) return p.uuid;
      return (await api('/projects', { method: 'POST', body: JSON.stringify({ name: nome, description: 'rilascio unico (regia migrazioni)' }) })).uuid;
    },
    async serverUuid() { const s = await api('/servers'); if (s.length !== 1) throw new Stop(`Coolify: server non unico (${s.length})`); return s[0].uuid; },
    async creaRisorsaImmagine({ progetto, server, destinazione, nome, dominio }) {
      const j = await api('/applications/dockerimage', { method: 'POST', body: JSON.stringify({ project_uuid: progetto, server_uuid: server, destination_uuid: destinazione, environment_name: 'production', name: nome,
        docker_registry_image_name: 'traefik/whoami', docker_registry_image_tag: 'v1.10.3', ports_exposes: '3000', domains: dominio, instant_deploy: false }) });
      await api(`/applications/${j.uuid}/envs`, { method: 'POST', body: JSON.stringify({ key: 'WHOAMI_PORT_NUMBER', value: '3000' }) });
      return j.uuid;
    },
    async domini(uuid, domini) { await api(`/applications/${uuid}`, { method: 'PATCH', body: JSON.stringify({ domains: domini }) }); },
    /** PATCH di campi della risorsa (es. {domains, redirect}). */
    async aggiorna(uuid, campi) { await api(`/applications/${uuid}`, { method: 'PATCH', body: JSON.stringify(campi) }); },
    /** Variabili della risorsa: [{uuid, chiave, preview}] (i valori non servono e non si leggono). */
    async variabili(uuid) { return (await api(`/applications/${uuid}/envs`)).map(e => ({ uuid: e.uuid, chiave: e.key, preview: !!e.is_preview })); },
    /** Crea o aggiorna più variabili in una chiamata; letterali (nessuna interpolazione di $). */
    async scriviVariabili(uuid, coppie) {
      await api(`/applications/${uuid}/envs/bulk`, { method: 'PATCH', body: JSON.stringify({ data: coppie.map(c => ({ key: c.chiave, value: c.valore, is_preview: false, is_literal: true })) }) });
    },
    async cancellaVariabile(uuid, envUuid) { await api(`/applications/${uuid}/envs/${envUuid}`, { method: 'DELETE' }); },
    async deploy(uuid, { limiteMs = 4 * 60000 } = {}) {
      const d = await api(`/deploy?uuid=${uuid}&force=false`, { method: 'POST' });
      const id = d?.deployments?.[0]?.deployment_uuid;
      if (!id) throw new Stop('Coolify non ha restituito il deployment');
      const fine = Date.now() + limiteMs; let stato = '';
      while (Date.now() < fine) {
        stato = (await api(`/deployments/${id}`)).status;
        if (stato === 'finished') return id;
        if (/^(failed|cancelled)/.test(stato)) throw new Stop(`deploy Coolify ${stato}`);
        await sleep(attesaMs);
      }
      throw new Stop(`deploy Coolify oltre il tempo massimo (ultimo stato: ${stato})`);
    },
  };
}

// ---------- Cloudflare DNS ----------
export function cloudflare(env, { fetchFn = fetch } = {}) {
  serve(env, ['CLOUDFLARE_API_TOKEN']);
  const h = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' };
  const api = async (path, init = {}) => {
    const r = await chiamaJson(fetchFn, path, `https://api.cloudflare.com/client/v4${path}`, { ...init, headers: h });
    if (!r.ok || !r.json?.success) throw new Stop(`Cloudflare ${init.method || 'GET'} ${path.split('?')[0]} -> HTTP ${r.status}: ${JSON.stringify(r.json?.errors || []).slice(0, 200)}`);
    return r.json.result;
  };
  return {
    async zona(nome) { const z = await api(`/zones?name=${encodeURIComponent(nome)}`); if (!z[0]) throw new Stop(`Cloudflare: zona ${nome} non trovata (il token la vede?)`); return z[0].id; },
    async record(zona, nome) { return (await api(`/zones/${zona}/dns_records?name=${encodeURIComponent(nome)}`)).map(r => ({ id: r.id, tipo: r.type, contenuto: r.content, proxied: r.proxied })); },
    async creaA(zona, nome, ip, commento = 'collaudo (regia migrazioni)') { return api(`/zones/${zona}/dns_records`, { method: 'POST', body: JSON.stringify({ type: 'A', name: nome, content: ip, proxied: true, ttl: 1, comment: commento }) }); },
    /** Tutti i record della zona (export completo, per il rollback). */
    async tuttiRecord(zona) {
      const out = [];
      for (let p = 1; p < 50; p++) {
        const r = await api(`/zones/${zona}/dns_records?per_page=500&page=${p}`);
        out.push(...r.map(x => ({ id: x.id, nome: x.name, tipo: x.type, contenuto: x.content, proxied: !!x.proxied, ttl: x.ttl, priorita: x.priority ?? null, dati: x.data ?? null, commento: x.comment ?? null })));
        if (r.length < 500) break;
      }
      return out;
    },
    async creaRecord(zona, r) {
      const corpo = { type: r.tipo, name: r.nome, content: r.contenuto, ttl: r.ttl || 1, proxied: r.proxied, ...(r.priorita != null ? { priority: r.priorita } : {}), ...(r.dati ? { data: r.dati } : {}), ...(r.commento ? { comment: r.commento } : {}) };
      const x = await api(`/zones/${zona}/dns_records`, { method: 'POST', body: JSON.stringify(corpo) });
      return x.id;
    },
    /** Modifica in place (anche il tipo, es. CNAME → A): nessun momento senza record. */
    async aggiornaRecord(zona, id, r) {
      await api(`/zones/${zona}/dns_records/${id}`, { method: 'PATCH', body: JSON.stringify({ type: r.tipo, name: r.nome, content: r.contenuto, proxied: r.proxied, ttl: r.ttl || 1, ...(r.commento ? { comment: r.commento } : {}) }) });
    },
    async cancellaRecord(zona, id) { await api(`/zones/${zona}/dns_records/${id}`, { method: 'DELETE' }); },
    /** Valore di un'impostazione della zona, null se il token non la può leggere. */
    async impostazione(zona, nome) {
      const r = await chiamaJson(fetchFn, nome, `https://api.cloudflare.com/client/v4/zones/${zona}/settings/${nome}`, { headers: h });
      return r.ok && r.json?.success ? r.json.result.value : null;
    },
    async rotte(zona) { return (await api(`/zones/${zona}/workers/routes`)).map(r => ({ id: r.id, schema: r.pattern, script: r.script ?? null })); },
    async creaRotta(zona, schema, script) { return (await api(`/zones/${zona}/workers/routes`, { method: 'POST', body: JSON.stringify({ pattern: schema, script }) })).id; },
    async cancellaRotta(zona, id) { await api(`/zones/${zona}/workers/routes/${id}`, { method: 'DELETE' }); },
    /** Carica un Worker a modulo singolo (nessuna route qui). */
    async caricaWorker(account, nome, codice, dataCompatibilita = '2026-10-27') {
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({ main_module: 'worker.mjs', compatibility_date: dataCompatibilita })], { type: 'application/json' }));
      form.append('worker.mjs', new Blob([codice], { type: 'application/javascript+module' }), 'worker.mjs');
      const r = await chiamaJson(fetchFn, nome, `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${nome}`, { method: 'PUT', body: form, headers: { Authorization: h.Authorization } });
      if (!r.ok || !r.json?.success) throw new Stop(`Cloudflare caricamento Worker ${nome} -> HTTP ${r.status}: ${JSON.stringify(r.json?.errors || []).slice(0, 200)}`);
    },
    async cancellaWorker(account, nome) {
      const r = await chiamaJson(fetchFn, nome, `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${nome}?force=true`, { method: 'DELETE', headers: h });
      if (!r.ok && r.status !== 404) throw new Stop(`Cloudflare cancellazione Worker ${nome} -> HTTP ${r.status}`);
    },
  };
}

// ---------- HTTP verso i siti (controlli dal runner) ----------
/** GET/POST semplice con tempo massimo; mai segreti negli header. Ritorna {status, headers, testo} o {status: 0, errore}. */
export function http({ fetchFn = fetch } = {}) {
  return async (url, { metodo = 'GET', corpo, headers = {}, timeoutMs = 15000 } = {}) => {
    try {
      const r = await fetchFn(url, { method: metodo, body: corpo, headers: { 'User-Agent': 'migrazioni-regia/1', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      return { status: r.status, headers: Object.fromEntries(r.headers.entries()), testo: await r.text() };
    } catch (e) { return { status: 0, headers: {}, testo: '', errore: e.message }; }
  };
}

// ---------- Telegram ----------
export function telegram(env, { fetchFn = fetch } = {}) {
  return async testo => {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
    const link = env.GITHUB_RUN_ID ? `\n${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : '';
    try {
      await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `${testo}${link}`.slice(0, 3500), disable_web_page_preview: true }) });
      return true;
    } catch { return false; }
  };
}

// ---------- Regia: file in stato/ e vps/ del checkout corrente, con commit e push ----------
export function regia({ radice, esegui = eseguiReale, sleep = sleepReale, ramo = 'main' } = {}) {
  // Identità fissa: sul runner non c'è una configurazione git globale (commit e rebase la richiedono).
  const git = (args, opt = {}) => esegui('git', ['-c', 'user.name=regia-migrazioni', '-c', 'user.email=regia@lorentso.it', ...args], { cwd: radice, ...opt });
  const leggiLocale = p => (existsSync(join(radice, p)) ? readFileSync(join(radice, p), 'utf8') : null);
  return {
    leggi: p => { const t = leggiLocale(p); return t == null ? null : JSON.parse(t); },
    /** Scrive un file JSON e lo porta su origin/main subito (pull --rebase prima del push). Una sola volta. */
    salva(p, oggetto, messaggio) {
      mkdirSync(dirname(join(radice, p)), { recursive: true });
      writeFileSync(join(radice, p), `${JSON.stringify(oggetto, null, 2)}\n`);
      git(['add', p]);
      if (git(['diff', '--cached', '--quiet'], { silenzioso: true }).status === 0) return false;
      git(['commit', '--quiet', '-m', messaggio]);
      git(['pull', '--quiet', '--rebase', 'origin', ramo]);
      git(['push', '--quiet', 'origin', `HEAD:${ramo}`]);
      return true;
    },
    /** Rilegge un file da origin/main (fetch): per gli esiti scritti dall'agente VPS. */
    leggiRemoto(p) {
      git(['fetch', '--quiet', 'origin', ramo]);
      const r = git(['show', `origin/${ramo}:${p}`], { silenzioso: true });
      return r.status === 0 ? JSON.parse(r.stdout) : null;
    },
    /** Aspetta finché condizione(oggetto) è vera, rileggendo ogni attesaMs, al massimo limiteMs. */
    async attendi(p, condizione, { attesaMs = 30000, limiteMs = 15 * 60000 } = {}) {
      const fine = Date.now() + limiteMs; let ultimo = null;
      while (true) {
        ultimo = this.leggiRemoto(p);
        if (ultimo && condizione(ultimo)) return ultimo;
        if (Date.now() >= fine) return null;
        await sleep(attesaMs);
      }
    },
  };
}
