// Worker di failover generico (fase B3). Stessa logica del Worker di La Cisterna
// (coolify/scripts/cloudflare-failover-worker.js), con le regole del sito spostate
// nella configurazione. Le configurazioni per sito stanno in ./siti/<sito>.mjs.
//
// Regola asset (B.0.1): un 404 dell'origine viene ritentato sul backup SOLO per i
// percorsi della lista verificata `standbyAssets`, generata dalla pipeline a ogni
// release. Non esiste una regola "qualunque 404 sotto /_next/static/": vedi
// templates/rilascio/README.md, sezione "Regola asset".
const AFFINITY = '__Host-vps-standby';
const SAFE_HEADERS = ['accept', 'accept-language', 'accept-encoding', 'range', 'if-none-match',
  'if-modified-since', 'rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-router-segment-prefetch',
  'next-url', 'x-nextjs-data', 'x-deployment-id'];
const NO_BODY = new Set([101, 204, 205, 304]);
const HOST = /^[a-z0-9.-]+$/;

// Cookie tecnici comuni (Cloudflare e analytics): non bloccano il failover e
// non vengono mai inoltrati al backup. Il sito può aggiungerne altri.
export const COMMON_TECHNICAL_COOKIES = Object.freeze(['__cf_bm', 'cf_clearance', 'cf_ob_info', 'cf_use_ob',
  '__cfwaitingroom', '__cfruid', '_cfuvid', '__cflb', 'cf_chl_rc_i', 'cf_chl_rc_ni', 'cf_chl_rc_m',
  '_ga', '_gid', '_gat', '_gcl_au', '_fbp', '_fbc']);
export const COMMON_TECHNICAL_PATTERNS = Object.freeze([/^(?:_ga_[A-Za-z0-9]+|_gat_[A-Za-z0-9_]+)$/]);
export const DEFAULT_SENSITIVE_COOKIE = /(?:auth|session|jwt|token|preview|prerender|draft|csrf)/i;
export const DEFAULT_EXCLUDED_PREFIXES = Object.freeze(['/api', '/.well-known/acme-challenge']);

function regexList(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(r => r instanceof RegExp)) throw new Error(`Invalid failover configuration: ${name}`);
  return value;
}
function stringList(value, name, check = () => true) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string' && check(v))) throw new Error(`Invalid failover configuration: ${name}`);
  return value;
}

/** Valida e normalizza la configurazione di un sito. Errore = il Worker non parte. */
export function normalizeConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('Invalid failover configuration');
  const { publicHosts, standbyHost, timeoutMs = 5000, circuitMs = 60000 } = config;
  if (!Array.isArray(publicHosts) || !publicHosts.length || typeof standbyHost !== 'string' || !standbyHost ||
      publicHosts.includes(standbyHost) ||
      ![...publicHosts, standbyHost].every(h => typeof h === 'string' && HOST.test(h) && !h.startsWith('.') && !h.endsWith('.')) ||
      !(timeoutMs > 0) || !(circuitMs > 0)) throw new Error('Invalid failover configuration');
  const locale = config.localeCookie ?? null;
  if (locale !== null && (typeof locale.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(locale.name) ||
      !Array.isArray(locale.values) || !locale.values.length || !locale.values.every(v => /^[A-Za-z0-9_-]+$/.test(v)))) {
    throw new Error('Invalid failover configuration: localeCookie');
  }
  const prefix = p => p.startsWith('/') && !p.endsWith('/');
  return {
    publicHosts: [...publicHosts], standbyHost, timeoutMs, circuitMs,
    localeCookie: locale,
    publicPathPatterns: regexList(config.publicPathPatterns, 'publicPathPatterns'),
    publicExactPaths: new Set(stringList(config.publicExactPaths, 'publicExactPaths', p => p.startsWith('/'))),
    excludedPrefixes: stringList(config.excludedPrefixes ?? DEFAULT_EXCLUDED_PREFIXES, 'excludedPrefixes', prefix),
    technicalCookies: new Set([...COMMON_TECHNICAL_COOKIES, ...stringList(config.technicalCookies, 'technicalCookies')]),
    technicalCookiePatterns: [...COMMON_TECHNICAL_PATTERNS, ...regexList(config.technicalCookiePatterns, 'technicalCookiePatterns')],
    sensitiveCookie: config.sensitiveCookie ?? DEFAULT_SENSITIVE_COOKIE,
    // Solo percorsi esatti sotto /_next/static/, senza query o frammento.
    standbyAssets: new Set((config.standbyAssets || []).filter(path =>
      typeof path === 'string' && path.startsWith('/_next/static/') && !path.includes('?') && !path.includes('#'))),
  };
}

export function createHandler(siteConfig, dependencies = {}) {
  const c = normalizeConfig(siteConfig);
  const fetchFn = dependencies.fetch || ((...args) => fetch(...args));
  const now = dependencies.now || (() => Date.now());
  let circuitUntil = 0; // Stato locale a un isolate: best effort.

  const isPublicFallbackPath = path => path.startsWith('/_next/static/') || path === '/_next/image' ||
    c.publicExactPaths.has(path) || c.publicPathPatterns.some(r => r.test(path));
  const excluded = path => c.excludedPrefixes.some(p => path === p || path.startsWith(`${p}/`));
  const cookieParts = headers => (headers.get('cookie') || '').split(';').map(s => s.trim()).filter(Boolean);
  const isAffinity = part => part.split('=')[0] === AFFINITY;
  const cookieName = part => { const i = part.indexOf('='); return i === -1 ? part : part.slice(0, i); };
  const isTechnical = part => {
    const i = part.indexOf('='); if (i <= 0) return false;
    const name = part.slice(0, i);
    return c.technicalCookies.has(name) || c.technicalCookiePatterns.some(r => r.test(name));
  };
  function approvedCookies(parts, allowUnknown = false) {
    const nonAffinity = parts.filter(part => !isAffinity(part));
    if (nonAffinity.some(part => !part.includes('=') || c.sensitiveCookie.test(cookieName(part)))) return { approved: false, cookie: null };
    const localeName = c.localeCookie?.name;
    const localeParts = localeName ? nonAffinity.filter(part => cookieName(part) === localeName) : [];
    if (localeParts.length > 1) return { approved: false, cookie: null };
    if (localeParts.length === 1 && !c.localeCookie.values.some(v => localeParts[0] === `${localeName}=${v}`)) return { approved: false, cookie: null };
    if (!allowUnknown && nonAffinity.some(part => cookieName(part) !== localeName && !isTechnical(part))) return { approved: false, cookie: null };
    return { approved: true, cookie: localeParts[0] || null };
  }
  function requestWithoutAffinity(req) {
    const headers = new Headers(req.headers);
    const cookies = cookieParts(headers).filter(part => !isAffinity(part));
    if (cookies.length) headers.set('cookie', cookies.join('; ')); else headers.delete('cookie');
    return new Request(req, { headers });
  }
  const documentRequest = req => req.method === 'GET' && (req.headers.get('accept') || '').includes('text/html') &&
    !req.headers.has('rsc') && !req.headers.has('next-router-prefetch');
  function contentTypeFor(path) {
    if (/\.m?js$/i.test(path)) return 'application/javascript; charset=utf-8';
    if (/\.css$/i.test(path)) return 'text/css; charset=utf-8';
    if (/\.(png|jpg|jpeg|gif|webp|avif|svg|ico)$/i.test(path) || path.startsWith('/_next/image')) return 'application/octet-stream';
    if (/\.json$/i.test(path) || path.startsWith('/_next/data/')) return 'application/json; charset=utf-8';
    if (/\.(woff2?|ttf|otf)$/i.test(path)) return 'application/octet-stream';
    return 'text/html; charset=utf-8';
  }
  function unavailable(req) {
    const isRsc = req.headers.has('rsc') || (req.headers.get('accept') || '').includes('text/x-component');
    const headers = new Headers({ 'retry-after': '300', 'cache-control': 'no-store',
      'cdn-cache-control': 'no-store', 'cloudflare-cdn-cache-control': 'no-store',
      'content-type': isRsc ? 'text/x-component; charset=utf-8' : contentTypeFor(new URL(req.url).pathname) });
    return new Response(req.method === 'HEAD' ? null : 'Service temporarily unavailable', { status: 503, headers });
  }
  function discard(response) { try { response?.body?.cancel().catch(() => {}); } catch { /* best effort */ } }
  function withClearedAffinity(response, req) {
    const headers = new Headers(response.headers);
    headers.append('set-cookie', `${AFFINITY}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
    return new Response(req.method === 'HEAD' || NO_BODY.has(response.status) ? null : response.body,
      { status: response.status, statusText: response.statusText, headers });
  }
  function standbyResponse(response, req) {
    const headers = new Headers(response.headers);
    const location = headers.get('location');
    if (location) {
      let target;
      try { target = new URL(location, `https://${c.standbyHost}${new URL(req.url).pathname}`); } catch { return null; }
      if (target.hostname === c.standbyHost) {
        target.protocol = 'https:';
        target.host = new URL(req.url).host;
        if (target.href === req.url) return null;
        headers.set('location', target.href);
      }
    }
    if (headers.get('x-standby-noindex') === '1' && headers.get('x-robots-tag') === 'noindex, nofollow') headers.delete('x-robots-tag');
    headers.delete('x-standby-noindex');
    for (const name of ['cache-control', 'cdn-cache-control', 'cloudflare-cdn-cache-control']) headers.set(name, 'no-store');
    headers.set('x-served-by', 'vercel-hot-standby');
    if (documentRequest(req) && response.status >= 200 && response.status < 400) {
      headers.append('set-cookie', `${AFFINITY}=1; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=60`);
    }
    return new Response(req.method === 'HEAD' || NO_BODY.has(response.status) ? null : response.body,
      { status: response.status, statusText: response.statusText, headers });
  }
  async function timedFetch(request, options = {}) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('upstream timeout')); }, c.timeoutMs); });
    try { return await Promise.race([fetchFn(request, { ...options, redirect: 'manual', signal: controller.signal }), deadline]); }
    finally { clearTimeout(timer); }
  }
  async function primary(req) { try { return await timedFetch(requestWithoutAffinity(req)); } catch { return null; } }
  async function fallback(req) {
    const url = new URL(req.url);
    const target = new URL(`https://${c.standbyHost}`);
    target.pathname = url.pathname;
    target.search = url.search;
    const headers = new Headers();
    for (const name of SAFE_HEADERS) if (req.headers.has(name)) headers.set(name, req.headers.get(name));
    const allowed = approvedCookies(cookieParts(req.headers), isPublicFallbackPath(url.pathname));
    if (allowed.cookie) headers.set('cookie', allowed.cookie);
    headers.set('x-forwarded-host', url.hostname);
    const forwarded = new Request(target, { method: req.method, headers, redirect: 'manual' });
    let response;
    try { response = await timedFetch(forwarded, { cache: 'no-store' }); } catch { return null; }
    if (response.status >= 500) { await discard(response); return null; }
    const adjusted = standbyResponse(response, req);
    if (!adjusted) await discard(response);
    return adjusted;
  }
  return async function handle(req) {
    const url = new URL(req.url);
    if (!c.publicHosts.includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) return new Response(null, { status: 404 });
    const parts = cookieParts(req.headers);
    const affinity = parts.some(part => part === `${AFFINITY}=1`);
    const sensitive = !approvedCookies(parts, isPublicFallbackPath(url.pathname)).approved || req.headers.has('authorization') ||
      req.headers.has('proxy-authorization') || req.headers.has('upgrade') || req.headers.has('next-action');
    const retryable = ['GET', 'HEAD'].includes(req.method) && !req.body && !sensitive && !excluded(url.pathname);
    if (!retryable) return await primary(req) || unavailable(req);

    if (affinity || now() < circuitUntil) {
      const response = await fallback(req);
      if (response) return response;
      circuitUntil = 0;
      const origin = await primary(req);
      if (origin && origin.status < 500) return affinity ? withClearedAffinity(origin, req) : origin;
      if (origin) await discard(origin);
      return unavailable(req);
    }
    const origin = await primary(req);
    if (origin && origin.status === 404 && c.standbyAssets.has(url.pathname)) {
      const asset = await fallback(req);
      if (asset && asset.status !== 404) { await discard(origin); return asset; }
      if (asset) await discard(asset);
      return origin;
    }
    if (origin && origin.status < 500) return origin;
    if (origin) await discard(origin);
    const response = await fallback(req);
    if (!response) return unavailable(req);
    circuitUntil = now() + c.circuitMs;
    return response;
  };
}

/**
 * Lista asset per il Worker, presa dal file generato dalla pipeline
 * (generate-failover-allowlist-config.mjs). Rifiuta file di un'altra release.
 */
export function standbyAssetsFrom(allowlist, expected) {
  if (!allowlist || allowlist.schema !== 'failover-allowlist/v1' || !Array.isArray(allowlist.standbyAssets) ||
      allowlist.assetCount !== allowlist.standbyAssets.length || new Set(allowlist.standbyAssets).size !== allowlist.assetCount) {
    throw new Error('failover allowlist malformed');
  }
  if (!expected || allowlist.revision !== expected.revision || allowlist.manifestSha256 !== expected.manifestSha256) {
    throw new Error('failover allowlist does not match the expected release');
  }
  return allowlist.standbyAssets;
}
