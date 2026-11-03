# Decisioni e scadenze della regia (registro vivo)

Claude lo rilegge all'inizio di ogni sessione sulle migrazioni e avvisa Lorenzo quando una voce scade.
Ogni nuova scelta va aggiunta qui (una riga per voce: data, decisione, cosa comporta, quando ricordarla).

| Data | Decisione | Comporta | Da ricordare |
| --- | --- | --- | --- |
| 3/11/2026 | Token GitHub `MIGRAZIONI_GH_TOKEN` su **tutti i repository** di lorentsob | un repo nuovo si migra con il solo push di `siti/<sito>.json`; il token vive solo come secret di `migrazioni` | creato il 3/11/2026 con scadenza 90 giorni → **scade il 1/2/2027**; promemoria impostato per il 25/1/2027 |
| 3/11/2026 | Token dell'agente VPS limitato al solo repo `migrazioni` (Contents RW) | l'agente non può toccare altri repo | creato il 3/11/2026, 90 giorni → scade il 1/2/2027 (stesso promemoria); valore anche nel Keychain del Mac come `oracle-migrazioni-agente` |
| 3/11/2026 | desmare verrà spostato nell'account lorentsob | niente token di `desmare1`; `siti/desmare.json` punterà a `lorentsob/...` | prima di `prepara` su desmare: trasferimento fatto? |
| 3/11/2026 | `CLOUDFLARE_WORKERS_TOKEN` = token Cloudflare `github-cisterna-workers` (creato 3/11 per il Worker di La Cisterna), allargato con DNS Edit e Workers Routes Edit su `lorentso.it` e `lorenzoboschi.it`; nel Keychain del Mac con lo stesso nome del secret | serve a `prepara` (record di collaudo) | prima di `cutover`/`failover` di ogni sito: DNS Edit + Workers Routes Edit anche sulla zona del sito |
| 3/11/2026 | La risorsa Coolify la crea la regia; policy e backup li fa l'agente | niente `coolify-risorsa.yml` nel sito, niente script a mano | — |
| 3/11/2026 | Registro `rilasci-collaudo` fermo → cancellato dalla regia | il collaudo riparte da zero senza intervento | — |
| 3/11/2026 | Variabili Vercel mancanti in Preview solo segnalate | Lorenzo le imposta nel pannello | quando `prepara` lo scrive in `stato/<sito>.json` |
| 3/11/2026 | 10/11 ore 10: ritiro della risorsa vecchia La Cisterna `bwxkphpx…` | con l'agente attivo: voce `voluto: ritirata` in `vps/registro.json` dopo l'eliminazione in Coolify | promemoria già impostato nel thread di La Cisterna |
| 3/11/2026 | Repo `lorentsob/migrazioni` creato e regia pubblicata (5 commit, `test` verde al primo giro) | da qui in poi la fonte unica è il repo su GitHub; `~/vps-oracle/migrazioni/` e `/mnt/project-files/migrazioni/` sono copie | — |
| 3/11/2026 | Ogni secret della regia sta nel Keychain del Mac con lo stesso nome del secret; `copia-secret.sh` legge da lì | i valori di cisterna (B4) non erano salvati: per la regia token nuovi (Vercel, Coolify, service token Access `migrazioni-regia`); `github-cisterna-workers` rollato e da riscrivere anche in cisterna | al rinnovo di un token: Keychain con `-U`, poi `copia-secret.sh` con `SOVRASCRIVI=1` |
