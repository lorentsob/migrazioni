// Worker ACME temporaneo (runbook §8/4C): prima del cambio DNS i nomi del sito puntano ancora a
// Vercel, quindi Let's Encrypt non raggiungerebbe Traefik. Questo Worker, sulle sole route
// <dominio>/.well-known/acme-challenge/*, inoltra le richieste HTTP della sfida alla VPS tramite
// origin-vps.<dominio> (cf.resolveOverride, stessa zona). Tutto il resto: 404, nessun inoltro.
export const nomeAcme = scheda => `${scheda.sito}-acme`;
export const origineAcme = scheda => `origin-vps.${scheda.dominio}`;
export const hostAcme = scheda => [scheda.dominio, ...(scheda.www ? [`www.${scheda.dominio}`] : [])];
export const rotteAcme = scheda => hostAcme(scheda).map(h => `${h}/.well-known/acme-challenge/*`);

export function codiceAcme(scheda) {
  return `// Worker ACME temporaneo per ${scheda.dominio} (regia migrazioni). Si cancella dopo il cutover.
const HOSTS = ${JSON.stringify(hostAcme(scheda))};
const ORIGINE = ${JSON.stringify(origineAcme(scheda))};
const TOKEN = /^\\/\\.well-known\\/acme-challenge\\/[A-Za-z0-9_-]{1,128}$/;
export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.protocol !== 'http:' || !HOSTS.includes(url.hostname) || !['GET', 'HEAD'].includes(req.method) || url.search || !TOKEN.test(url.pathname)) {
      return new Response('not found', { status: 404 });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      return await fetch(req.url, { method: req.method, redirect: 'manual', signal: controller.signal, cf: { resolveOverride: ORIGINE, cacheTtl: 0, cacheEverything: false } });
    } catch { return new Response('upstream error', { status: 502 }); }
    finally { clearTimeout(timer); }
  },
};
`;
}
