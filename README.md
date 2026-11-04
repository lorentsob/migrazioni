# migrazioni: regia delle migrazioni Vercel → VPS

Repository privato di regia (progetto `vps-oracle/docs/procedura-migrazione/MIGRAZIONE-AUTOMATICA.md`, 3/11/2026).
Qui stanno i secret delle pipeline e lo stato di ogni migrazione. Claude fa solo `git push` di
`siti/<sito>.json`; il workflow `migra` esegue la fase scritta nel file; l'agente sulla VPS registra
le risorse da solo. Lorenzo interviene per gli ok irreversibili ("ok collaudo", "ok cutover") e per i
passi che nessuna API raggiunge. La procedura v5 resta il riferimento di *cosa* va controllato.

## Cartelle

| Cartella | Chi scrive | Cosa |
| --- | --- | --- |
| `siti/<sito>.json` | Claude (push) | Scheda macchina del sito e `fase` richiesta. `siti/_esempio.json` spiega i campi. |
| `stato/<sito>.json` | workflow `migra` | Esito di ogni fase: passi, errore, valori (uuid Coolify, PR, commit collaudato), `attesa` (es. "ok collaudo"). |
| `vps/registro.json` | workflow `migra` | Stato voluto sulla VPS: risorse da registrare o ritirare, verifiche da fare (certificato, pausa). |
| `vps/esiti/<uuid\|id>.json` | agente VPS | Esito di ogni risorsa o verifica. La regia aspetta questi file. |
| `modelli/` | `regia/sincronizza-modelli.sh` | Copia di `vps-oracle/coolify/templates` + verificatore + lista asset. Fonte unica: `~/vps-oracle`. |
| `regia/` | — | `migra.mjs` (ingresso), `fasi/`, `lib/` (scheda, modelli, servizi, stato), `config.json` (valori non segreti). |
| `agente/` | — | `oracle-migrazioni.py`, unità systemd, `installa-agente.sh`. |
| `test/` | — | `npm test`: fixture finte, nessuna rete. |

## Come si lancia una fase

1. Claude scrive o aggiorna `siti/<sito>.json` con `"fase": "prepara"` (o la successiva) e fa push su `main`.
2. `migra.yml` parte (una migrazione alla volta), esegue la fase, scrive `stato/<sito>.json` e avvisa su Telegram
   (`MIGRAZIONE … PASS` oppure `STOP migrazione …`).
3. Claude legge `stato/<sito>.json` (API contenuti) e decide il passo dopo. Rifare una fase: nuovo push dello
   stesso file (anche solo la `note`); le fasi successive nello stato vengono azzerate.

| Fase | Fa | Ok di Lorenzo |
| --- | --- | --- |
| `prepara` | Controlla repo e progetto Vercel (e le variabili Preview: avviso se mancano). Record A `collaudo-<sito>.lorentso.it` → VPS. Bypass Vercel (riusa quello esistente). Secret e variabili del sito. Risorsa Coolify a immagine (segnaposto whoami) sul nome di collaudo. Registrazione policy+backup via agente. Ramo `collaudo/rilascio-unico` con i modelli configurati e `vercel.json`, PR bozza. | no |
| `collaudo` | Prerequisiti C2 sul ramo (standalone, health, healthcheck, SOURCE_COMMIT, vercel.json). Rilascio in modalità collaudo (`gh workflow run rilascio-unico.yml --ref collaudo/rilascio-unico`), attesa del run, `release.json` completo. `verifica-sito.sh` dal runner. Certificato dall'origine via agente. Link a Lorenzo. | **sì: "ok collaudo"** |
| `cutover` | export zona, variabili Vercel → Coolify, backup su Vercel, Worker ACME, domini e certificati; poi ATTESA "ok cutover DNS"; con `ok.cutover` nella scheda: merge, DNS verso la VPS (rollback automatico), secondo rilascio | Lorenzo: "ok cutover DNS" |
| `failover` | Worker di failover pubblicato, route via API, prova con la pausa del container | — |
| `chiudi` | dal giorno dopo: verifica-sito, certificati, pulizia del collaudo | — |

Tra `prepara` e `collaudo` Claude completa il codice del sito (C2) sul ramo aperto dalla regia: ogni push sul
ramo fa già partire un rilascio di collaudo del sito, quindi `collaudo` lo trova fatto oppure ne lancia uno.

## Secret e variabili della regia

Secret (`regia/copia-secret.sh` li imposta tutti): `MIGRAZIONI_GH_TOKEN` (token fine-grained sui repo dei siti:
Actions, Contents, Pull requests, Secrets, Variables, Workflows in scrittura; Metadata in lettura), `VERCEL_TOKEN`,
`COOLIFY_TOKEN` (read, write, deploy), `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `CLOUDFLARE_WORKERS_TOKEN` (Workers Scripts: Edit **più** Zone DNS: Edit su `lorentso.it` e
sulle zone dei siti, Workers Routes: Edit). Il bypass Vercel di ogni sito lo legge la regia dal progetto Vercel.
Valori non segreti: `regia/config.json` (URL Coolify, IP VPS, zona di collaudo, account Cloudflare, team Vercel,
risorsa Coolify di riferimento, attese).

## Agente VPS

`agente/installa-agente.sh` (root sulla VPS, una volta): installa `oracle-migrazioni.py` e il timer ogni 5 minuti.
Legge `vps/registro.json` con un token GitHub limitato a questo repository (Contents read/write), applica policy
e backup con lo stesso codice di `registra-risorsa-vps.sh`/`ritira-risorsa-vps.sh` (copie di sicurezza, rollback
se `validate_coverage` o `oracle-security-alerts` falliscono) e scrive `vps/esiti/`. Non riceve comandi: confronta
lo stato voluto con quello reale. Verifiche possibili: `certificato` (openssl verso l'origine) e `pausa`
(docker pause ≤ 300 s, una volta per id, entro `scade`). Log: `journalctl -u oracle-migrazioni.service`.

## Test

```
npm test        # node --test 'test/*.test.mjs' (regia, adattatori con fetch/git finti, passo del workflow) + python unittest (agente)
```
Nessun test tocca la rete, GitHub, Vercel, Coolify o la VPS.
