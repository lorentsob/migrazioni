# Lista una tantum per Lorenzo (circa 20-25 minuti)

Da fare una volta sola, in quest'ordine. Nessun valore segreto va scritto in chat: i passi 2-4 usano `gh`
dal Mac e il Keychain. Quando hai finito scrivi "una tantum fatta" a Claude, che fa il resto.

## 1. Repository di regia (2 min)

Crea il repository **privato** `lorentsob/migrazioni` su https://github.com/new (vuoto, senza README).
Poi dillo a Claude: lo aggiunge alla sessione (`add_repo`) e fa il push del contenuto preparato
(`/mnt/project-files/migrazioni/`, specchio anche in `~/vps-oracle/migrazioni/` dopo la sincronizzazione).

## 2. Token GitHub "migrazioni-regia" (5 min)

https://github.com/settings/personal-access-tokens/new → Fine-grained:
- Repository access: **Only select repositories** → i repo dei siti da migrare
  (`portfolio-lorenzo-boschi`, `cisterna`, `incontroluce`, …; `desmare` è di un altro owner: si vedrà dopo).
- Permissions (Repository): Actions **Read and write**, Contents **Read and write**, Metadata Read,
  Pull requests **Read and write**, Secrets **Read and write**, Variables **Read and write**, Workflows **Read and write**.
- Scadenza: 90 giorni va bene (la regia avvisa su Telegram se le chiamate falliscono).
Salvalo nel Keychain con nome `MIGRAZIONI_GH_TOKEN` (così lo script del passo 4 lo trova):
`security add-generic-password -a lorentso -s MIGRAZIONI_GH_TOKEN -w` (chiede il valore senza mostrarlo).

## 3. Token GitHub "oracle-migrazioni-agente" (3 min)

Stessa pagina, un secondo token: Repository access **solo `lorentsob/migrazioni`**, Permissions: Contents
**Read and write**, Metadata Read. Serve al passo 5 (lo chiede `installa-agente.sh`), non va nella regia.

## 4. Token Cloudflare e secret nella regia (5 min)

- Dashboard Cloudflare → My Profile → API Tokens → modifica il token usato per `CLOUDFLARE_WORKERS_TOKEN`
  (quello di B4 S2-A) aggiungendo: **Zone → DNS → Edit** su `lorentso.it` e sulle zone dei siti
  (`lorenzoboschi.it`, …) e **Zone → Workers Routes → Edit** sulle stesse zone. Oppure creane uno nuovo con
  Workers Scripts: Edit + quei permessi e usa quello.
- Dal Mac, nella cartella del repo `migrazioni` clonato: `regia/copia-secret.sh lorentsob/migrazioni`.
  Per ogni secret legge il Keychain (voce con lo stesso nome) oppure chiede il valore senza eco. I valori sono
  gli stessi già messi in `lorentsob/cisterna` (B1 e S2-A) più `MIGRAZIONI_GH_TOKEN`.

## 5. Agente sulla VPS (5 min)

Leggi prima `agente/installa-agente.sh` e `agente/oracle-migrazioni.py`. Poi, dal repo clonato:
```
scp -r agente oracle-vps:/tmp/agente && ssh -t oracle-vps 'sudo bash /tmp/agente/installa-agente.sh'
```
Chiede il token del passo 3, abilita il timer (ogni 5 min), fa un giro in dry-run e stampa `PASS agente installato`.
Se `/usr/local/lib/oracle-backup/pipeline_contract.py` non c'è, lo script lo dice: fermati e dillo a Claude.

## Per ogni sito, da qui in poi

- "migra <sito>": Claude compila `siti/<sito>.json`, ti fa le domande di C0 (finestra, posta, CMS) in un messaggio solo,
  poi spinge `fase: prepara` e completa il codice (C2) sul ramo aperto dalla regia.
- Variabili Vercel: se `prepara` avvisa che in **Preview** mancano variabili presenti in Production, le imposti
  nel pannello Vercel del progetto (è l'unico passo fuori API: i valori sensibili non si leggono).
- "ok collaudo <sito>" dopo un giro su `https://collaudo-<sito>.lorentso.it`, poi "ok cutover <sito>" (fasi della
  prossima sessione).
