// Configurazione del Worker generico per lacisterna.eu. Riproduce le regole del
// Worker attuale (coolify/scripts/cloudflare-failover-worker.js): verificato dal
// test failover_worker_generico.test.mjs, che confronta i due su una matrice di richieste.
export const lacisterna = Object.freeze({
  publicHosts: ['lacisterna.eu', 'www.lacisterna.eu'],
  standbyHost: 'backup.lacisterna.eu',
  timeoutMs: 5000,
  circuitMs: 60000,
  localeCookie: { name: 'NEXT_LOCALE', values: ['it', 'en'] },
  // Pagine pubbliche: home, /it, /en e due livelli sotto la lingua.
  publicPathPatterns: [
    /^\/$/,
    /^\/(?:it|en)(?:\/[A-Za-z0-9_-]+){0,2}\/?$/,
    /^\/payment-icons\/(?:samsung-pay|vpay|jcb|google-pay|amex|apple-pay|mastercard|unionpay|amex-brand|discover|diners|maestro|nfc|visa|satispay)\.svg$/,
  ],
  publicExactPaths: ['/favicon.ico', '/icon.ico', '/robots.txt', '/sitemap.xml', '/globe.svg', '/file.svg',
    '/favicon-32.png', '/favicon-16.png', '/logo.png', '/logo-small.png', '/apple-touch-icon.png',
    '/images/restaurant.svg', '/images/og-image.svg'],
  // API, anteprime Prismic, slice simulator e sfide ACME non passano mai dal backup.
  excludedPrefixes: ['/api', '/preview', '/slice-simulator', '/.well-known/acme-challenge'],
  // Iubenda divide i valori lunghi in -1, -2, ...
  technicalCookiePatterns: [/^_iub_cs-s4392856(?:-uspr)?(?:-\d+)?$/],
});
