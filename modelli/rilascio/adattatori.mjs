// Adattatori reali per promuovi.mjs: Coolify (via Cloudflare Access), Vercel (REST),
// registro su GitHub (ramo dedicato, scrittura con controllo di versione), Telegram.
// Nessun segreto viene stampato. Ogni funzione fa una sola richiesta di modifica;
// le attese sono solo letture ripetute dello stato (polling), mai nuovi tentativi.
import { spawnSync } from 'node:child_process';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function serve(env, nomi) {
  const mancanti = nomi.filter(n => !env[n]);
  if (mancanti.length) throw new Error(`variabili mancanti: ${mancanti.join(', ')}`);
}

export function coolify(env, { fetchFn = fetch, attesaMs = 5000, limiteMs = 20 * 60000 } = {}) {
  serve(env, ['COOLIFY_URL', 'COOLIFY_TOKEN', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET', 'COOLIFY_APP_UUID']);
  const base = new URL('/api/v1/', env.COOLIFY_URL);
  const headers = {
    'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
    Authorization: `Bearer ${env.COOLIFY_TOKEN}`, Accept: 'application/json',
  };
  async function api(path, init = {}) {
    const r = await fetchFn(new URL(path, base), { ...init, headers: { ...headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
    const text = await r.text();
    if (!r.ok) throw new Error(`Coolify ${init.method || 'GET'} ${path} -> HTTP ${r.status}`);
    try { return JSON.parse(text); } catch { throw new Error(`Coolify ${path}: risposta non JSON`); }
  }
  const uuid = encodeURIComponent(env.COOLIFY_APP_UUID);
  return {
    // Riferimento attivo nella configurazione della risorsa (tipo "Docker image").
    async leggi() {
      const app = await api(`applications/${uuid}`);
      const nome = app.docker_registry_image_name, tag = app.docker_registry_image_tag;
      if (!nome) return `git:${app.git_commit_sha || 'sconosciuto'}`; // risorsa ancora da git (situazione attuale)
      return String(tag || '').startsWith('sha256:') ? `${nome}@${tag}` : `${nome}:${tag || 'latest'}`;
    },
    async aggiorna(immagine) {
      // "nome@sha256:..." oppure "nome:tag" (Coolify 4.4.7 accetta solo il secondo).
      const i = immagine.includes('@') ? immagine.indexOf('@') : immagine.lastIndexOf(':');
      const nome = immagine.slice(0, i), tag = immagine.slice(i + 1);
      const r = await fetchFn(new URL(`applications/${uuid}`, base), { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ docker_registry_image_name: nome, docker_registry_image_tag: tag }) });
      if (!r.ok) throw new Error(`Coolify PATCH -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const d = await api(`deploy?uuid=${uuid}&force=false`, { method: 'POST' }); // Coolify 4.4.7: solo POST
      const id = d?.deployments?.[0]?.deployment_uuid;
      if (!id) throw new Error('Coolify non ha restituito il deployment');
      const fine = Date.now() + limiteMs;
      while (Date.now() < fine) {
        const s = (await api(`deployments/${encodeURIComponent(id)}`)).status;
        if (s === 'finished') return;
        if (['failed', 'cancelled-by-user', 'cancelled'].includes(s)) throw new Error(`deploy Coolify ${s}`);
        await sleep(attesaMs);
      }
      throw new Error('deploy Coolify oltre il tempo massimo');
    },
  };
}

export async function saluteCommit(dominio, { fetchFn = fetch } = {}) {
  const r = await fetchFn(`https://${dominio}/api/health`, { headers: { 'cache-control': 'no-cache', 'user-agent': 'rilascio-unico/1' } });
  if (!r.ok) throw new Error(`health ${dominio} -> HTTP ${r.status}`);
  const j = await r.json();
  return j?.status === 'ok' ? j.revision : null;
}

export async function attendiSalute(dominio, commit, { fetchFn = fetch, attesaMs = 5000, limiteMs = 4 * 60000 } = {}) {
  const fine = Date.now() + limiteMs; let ultimo = null;
  while (true) {
    try { ultimo = await saluteCommit(dominio, { fetchFn }); if (ultimo === commit) return ultimo; }
    catch (e) { ultimo = `errore: ${e.message}`; }
    if (Date.now() >= fine) return ultimo;
    await sleep(attesaMs);
  }
}

export function vercel(env, { fetchFn = fetch, attesaMs = 5000, limiteMs = 3 * 60000 } = {}) {
  serve(env, ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID', 'BACKUP_DOMINIO']);
  const team = `teamId=${encodeURIComponent(env.VERCEL_ORG_ID)}`;
  async function api(path, init = {}) {
    const r = await fetchFn(`https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}${team}`,
      { ...init, headers: { Authorization: `Bearer ${env.VERCEL_TOKEN}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
    const text = await r.text();
    if (!r.ok) throw new Error(`Vercel ${init.method || 'GET'} ${path.split('?')[0]} -> HTTP ${r.status}`);
    try { return text ? JSON.parse(text) : {}; } catch { throw new Error('Vercel: risposta non JSON'); }
  }
  // COLLAUDO B4 (sessione 1): con VERCEL_ALIAS_TEST la "promozione" è l'assegnazione di un
  // alias *.vercel.app di test a una preview; nessun dominio né /promote di produzione.
  const test = env.VERCEL_ALIAS_TEST || null;
  const leggi = async () => {
    if (test) {
      const r = await fetchFn(`https://api.vercel.com/v4/aliases/${encodeURIComponent(test)}?${team}`,
        { headers: { Authorization: `Bearer ${env.VERCEL_TOKEN}`, Accept: 'application/json' } });
      if (r.status === 404) return 'dpl_nessunalias';
    }
    const a = await api(`/v4/aliases/${encodeURIComponent(test || env.BACKUP_DOMINIO)}`);
    const id = a.deploymentId || a.deployment?.id;
    if (!/^dpl_[A-Za-z0-9]+$/.test(id || '')) throw new Error('alias del backup senza deployment');
    return id;
  };
  return {
    leggi,
    async deployment(idOrUrl) { return api(`/v13/deployments/${encodeURIComponent(idOrUrl)}`); },
    async promuovi(id) {
      if (test) {
        await api(`/v2/deployments/${encodeURIComponent(id)}/aliases`, { method: 'POST', body: JSON.stringify({ alias: test }) });
        if (await leggi() !== id) throw new Error('alias di test non assegnato');
        return;
      }
      await api(`/v10/projects/${encodeURIComponent(env.VERCEL_PROJECT_ID)}/promote/${encodeURIComponent(id)}`, { method: 'POST' });
      const fine = Date.now() + limiteMs;
      while (Date.now() < fine) { if (await leggi() === id) return; await sleep(attesaMs); }
    },
  };
}

/** release.json sul ramo dedicato (default "rilasci"); la versione è lo sha del blob GitHub. */
export function registroGitHub(env, { fetchFn = fetch, file = 'release.json', attesaMs = 3000, tentativi = 4 } = {}) {
  serve(env, ['GITHUB_TOKEN', 'GITHUB_REPOSITORY']);
  const ramo = env.RAMO_REGISTRO || 'rilasci';
  const url = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/contents/${file}`;
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  return {
    async leggi() {
      const r = await fetchFn(`${url}?ref=${encodeURIComponent(ramo)}`, { headers });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`registro: lettura HTTP ${r.status}`);
      const j = await r.json();
      return { release: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), versione: j.sha };
    },
    async salva(release, versione) {
      const body = { message: `registro: ${release.sito} ${release.commit.slice(0, 7)} ${release.esito}`, branch: ramo,
        content: Buffer.from(`${JSON.stringify(release, null, 2)}\n`).toString('base64'), ...(versione ? { sha: versione } : {}) };
      // Un errore di rete (run 41887773753: "fetch failed" sull'ultima scrittura) non deve lasciare il
      // registro a metà: si ritenta. Se la scrittura persa era in realtà arrivata, il nuovo PUT dà
      // conflitto: allora si rilegge e, se il contenuto è proprio il nostro, si prende la sua versione.
      let reteKo = false, ultimo;
      for (let i = 0; i < tentativi; i++) {
        if (i) await sleep(attesaMs * i);
        let r;
        try { r = await fetchFn(url, { method: 'PUT', headers, body: JSON.stringify(body) }); }
        catch (e) { reteKo = true; ultimo = e; continue; }
        if (r.status === 409 || r.status === 422) {
          if (reteKo) {
            const g = await fetchFn(`${url}?ref=${encodeURIComponent(ramo)}`, { headers }).catch(() => null);
            if (g?.ok) { const j = await g.json(); if (Buffer.from(j.content, 'base64').toString('utf8') === `${JSON.stringify(release, null, 2)}\n`) return j.sha; }
          }
          throw new Error('registro modificato da un altro rilascio (conflitto di versione)');
        }
        if (r.status >= 500) { ultimo = new Error(`registro: scrittura HTTP ${r.status}`); continue; }
        if (!r.ok) throw new Error(`registro: scrittura HTTP ${r.status}`);
        return (await r.json()).content.sha;
      }
      throw ultimo;
    },
  };
}

export function telegram(env, { fetchFn = fetch } = {}) {
  return async testo => {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
    const link = env.GITHUB_RUN_ID ? `\n${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : '';
    await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `${testo}${link}`.slice(0, 3500), disable_web_page_preview: true }),
    });
  };
}

export function adattatoriReali(env, candidato) {
  const c = coolify(env), v = vercel(env), reg = registroGitHub(env);
  return {
    leggiRegistro: reg.leggi, salvaRegistro: reg.salva,
    leggiVps: c.leggi, aggiornaVps: c.aggiorna,
    // Coolify dice "finished" prima che il container sia healthy (B4: 503 per ~30 s).
    // Solo letture ripetute fino a health = commit o al limite: nessun nuovo deploy.
    saluteVps: () => attendiSalute(env.DOMINIO, candidato.commit),
    leggiVercel: v.leggi,
    // COLLAUDO B4: SIMULA=passo6 fa fallire la promozione Vercel senza chiamare Vercel.
    promuoviVercel: env.SIMULA === 'passo6' ? async () => { throw new Error('promozione Vercel fallita (simulata, collaudo B4)'); } : v.promuovi,
    verifica: async () => {
      serve(env, ['VERIFICA_SITO', 'DOMINIO', 'BACKUP_DOMINIO']);
      const r = spawnSync('bash', [env.VERIFICA_SITO, env.DOMINIO, env.BACKUP_DOMINIO, candidato.commit], { stdio: 'inherit', timeout: 10 * 60000 });
      return r.status === 0;
    },
    avvisa: telegram(env),
  };
}
