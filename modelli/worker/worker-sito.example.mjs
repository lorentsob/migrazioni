// Punto di ingresso del Worker per un sito (esempio per La Cisterna).
// Nel repository del sito: .github/rilascio/worker/worker-sito.mjs. A ogni release la pipeline
// scrive allowlist.json accanto a questo file e sostituisce qui revisione e hash attesi
// (passo "Pubblicazione del Worker"); il Worker rifiuta una lista di un'altra release.
import { createHandler, standbyAssetsFrom } from './failover-worker.mjs';
import { lacisterna } from './siti/lacisterna.mjs';
import allowlist from './allowlist.json' with { type: 'json' };

const RELEASE = Object.freeze({
  revision: 'SOSTITUIRE_CON_COMMIT_COMPLETO',
  manifestSha256: 'SOSTITUIRE_CON_HASH_MANIFEST',
});

export const config = Object.freeze({ ...lacisterna, standbyAssets: standbyAssetsFrom(allowlist, RELEASE) });
export default { fetch: createHandler(config) };
