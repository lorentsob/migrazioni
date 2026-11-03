# Rilascio unico: modelli (B3 28/10, collaudati in B4 S1 1/11, corretti dopo la review del 3/11)

Modelli della Parte B della procedura (`PROCEDURA-MIGRAZIONE-SITI.md` **v5**). Al 3/11 **non sono installati su nessun sito in produzione**: la prima installazione è B4 sessione 2 su La Cisterna.

Test (dalla radice di `vps-oracle`): `node --test 'coolify/scripts/tests/*.test.mjs'` (le virgolette servono con Node 22). `actionlint` gira in CI sul repository del sito.

## File da copiare nel repository del sito

| Origine (`vps-oracle/…`) | Destinazione nel repository del sito | Cosa fa |
| --- | --- | --- |
| `coolify/templates/rilascio-unico.yml` | `.github/workflows/rilascio-unico.yml` | Passi 0-8 di B.0, rollback con `workflow_dispatch`, pubblicazione del Worker |
| `coolify/templates/rilascio-sblocca.yml` | `.github/workflows/rilascio-sblocca.yml` | Sblocco manuale dopo uno STOP (ripristina / accetta / completa-vercel) |
| `coolify/templates/coolify-risorsa.yml` | `.github/workflows/coolify-risorsa.yml` | Crea la risorsa Coolify a immagine; sposta i domini da una risorsa da git |
| `coolify/templates/Dockerfile.prebuilt` | `.github/rilascio/Dockerfile.prebuilt` | Immagine ARM64 dallo standalone; utente 10001, healthcheck in Node |
| `coolify/templates/rilascio/asset.mjs`, `precheck.mjs`, `promuovi.mjs`, `adattatori.mjs` | `.github/rilascio/` | Manifest e unione asset; pre-check; passi 5-8 e sblocco; adattatori Coolify/Vercel/GitHub/Telegram |
| `coolify/scripts/generate-failover-allowlist-config.mjs` | `.github/rilascio/` | Lista asset per il Worker |
| `docs/procedura-migrazione/verifica-sito.sh` **e** `verifica_sito.py` | `.github/rilascio/` | Verificatore (il `.sh` lancia il `.py`: servono **tutti e due**) |
| `coolify/templates/worker/failover-worker.mjs`, `siti/<sito>.mjs`, `worker-sito.example.mjs` → `worker-sito.mjs`, `wrangler.example.jsonc` → `wrangler.jsonc` | `.github/rilascio/worker/` | Worker di failover (solo con `WORKER_FAILOVER=attivo`) |

Comando unico (dal Mac, nella cartella del repository del sito, `V=~/vps-oracle`):

```bash
mkdir -p .github/workflows .github/rilascio/worker/siti
cp $V/coolify/templates/{rilascio-unico,rilascio-sblocca,coolify-risorsa}.yml .github/workflows/
cp $V/coolify/templates/Dockerfile.prebuilt $V/coolify/templates/rilascio/{asset,precheck,promuovi,adattatori}.mjs \
   $V/coolify/scripts/generate-failover-allowlist-config.mjs \
   $V/docs/procedura-migrazione/{verifica-sito.sh,verifica_sito.py} .github/rilascio/
cp $V/coolify/templates/worker/failover-worker.mjs .github/rilascio/worker/
cp $V/coolify/templates/worker/worker-sito.example.mjs .github/rilascio/worker/worker-sito.mjs
cp $V/coolify/templates/worker/wrangler.example.jsonc .github/rilascio/worker/wrangler.jsonc
# poi: siti/<sito>.mjs (da siti/lacisterna.mjs), import e nome nel worker-sito.mjs e nel wrangler.jsonc
```

Controllo: `ls .github/rilascio .github/rilascio/worker` deve elencare 8 file e la cartella `worker/` (con `failover-worker.mjs`, `worker-sito.mjs`, `wrangler.jsonc` e `siti/`).

## Da adattare per sito

- Il blocco "CONFIGURAZIONE DEL SITO" in `rilascio-unico.yml` e, **identico**, in `rilascio-sblocca.yml` (un test lo controlla sui modelli).
- `IMMAGINE` = `ghcr.io/<owner del repository>/<nome>`: con `GITHUB_TOKEN` si pubblica solo nel namespace dell'owner del repository.
- `CONTESTO_EXTRA`: file fuori da `package.json` che servono a `npm ci` (per La Cisterna `.npmrc shims`). Se non ce ne sono, lasciare vuoto.
- `PAGINE` e `IMMAGINE_DI_PROVA` del pre-check.

## Due modalità, decise dal ramo

| Ramo | Vercel | Dominio verificato | Registro | Uso |
| --- | --- | --- | --- | --- |
| `main` | produzione: `--prod --skip-domain`, poi promote dell'id verificato su `BACKUP_DOMINIO` | `DOMINIO`, oppure la variabile `DOMINIO_OVERRIDE` se impostata (con `STAGING=1`) | `rilasci` | produzione e rollback |
| `collaudo/**` | solo preview + alias di test (variabile `VERCEL_ALIAS_TEST`) | variabile `DOMINIO_COLLAUDO` (`collaudo-<sito>.lorentso.it`), `STAGING=1` | `rilasci-collaudo` | C3 e prove; `[simula-passo6]` nel messaggio di commit simula lo STOP al passo 6 |

La modalità dipende solo dal ramo, mai da una variabile: un push su `main` non può finire in prova per errore, e una prova non può promuovere la produzione Vercel di un sito ancora servito da Vercel.

## Prerequisiti nel codice (C2)

`output: "standalone"`; `env: { SOURCE_COMMIT: process.env.SOURCE_COMMIT || "" }` in `next.config` (così anche Vercel dichiara il commit); `/api/health` che restituisce `{status:"ok", revision: process.env.SOURCE_COMMIT}` con `no-store`; `healthcheck.cjs` nella radice; `vercel.json` con `"git": {"deploymentEnabled": {"main": false}}` **solo** nella PR che attiva la pipeline.

## Secret e variabili del repository

Secret: `VERCEL_TOKEN`, `VERCEL_AUTOMATION_BYPASS_SECRET`, `COOLIFY_TOKEN` (permessi **read, write, deploy**), `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `CLOUDFLARE_WORKERS_TOKEN` (solo con il Worker).
Variabili: `COOLIFY_APP_UUID` (risorsa a immagine); per il collaudo `DOMINIO_COLLAUDO` e `VERCEL_ALIAS_TEST`; `DOMINIO_OVERRIDE` solo nel passaggio di un sito dal percorso base; `WORKER_FAILOVER` (`attivo` per pubblicare il Worker) e `CLOUDFLARE_ACCOUNT_ID` solo con il Worker.

## Scelte e risultati

- **Tag della VPS:** Coolify 4.4.7 rifiuta il digest come tag (422, B4 S1). La VPS riceve `immagine:<commit>-r<run>-<tentativo>`, unico per esecuzione e mai riassegnato; il digest resta in `release.json` ed è quello usato per gli asset conservati. Il suffisso rende possibile il rollback, cioè la ricostruzione di un commit già pubblicato (review 3/11, D1).
- **Coolify 4.4.7:** deploy con `POST /api/v1/deploy` (GET → 405); il token deve avere read, write e deploy (la PATCH dell'immagine richiede write); "finished" arriva prima di healthy, quindi il passo 5 attende con sole letture health = commit (massimo 4 minuti).
- **Pre-check Vercel:** `vercel deploy --prebuilt --prod --skip-domain` (in B4 S1 provato solo in preview: la prima prova di produzione è B4 S2). Gli URL `*.vercel.app` sono protetti: si usa `x-vercel-protection-bypass`, mai inviato ai domini propri.
- **Registro:** `release.json` sul ramo `rilasci`, scritto con controllo di versione (sha del blob). Un rilascio non parte se il registro non è `completo`; si sblocca solo con `rilascio-sblocca.yml`.
- **Asset conservati:** dalle immagini per digest delle ultime 2 release completate. Le immagini citate in `storico` non vanno cancellate da GHCR.
- **Worker:** resta la **lista verificata** (Turbopack non mette hash verificabili nei nomi). La lista si genera a ogni release; con `WORKER_FAILOVER=attivo` si pubblica con `wrangler@4.151.1` senza toccare le route. Pubblicazione reale da provare in B4 S2 (S2-D).

## Ancora da provare dal vivo (B4 sessione 2)

1. `POST /v10/projects/{id}/promote/{dpl}` su un deployment `--prod --skip-domain`, e build con le variabili di produzione.
2. `coolify-risorsa.yml` azione `sposta-domini` (PATCH `domains`, deploy, emissione del certificato).
3. Pubblicazione del Worker con `wrangler deploy` e route invariate.
4. Rollback reale con `workflow_dispatch`.
