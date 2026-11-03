# Decisioni e scadenze della regia (registro vivo)

Claude lo rilegge all'inizio di ogni sessione sulle migrazioni e avvisa Lorenzo quando una voce scade.
Ogni nuova scelta va aggiunta qui (una riga per voce: data, decisione, cosa comporta, quando ricordarla).

| Data | Decisione | Comporta | Da ricordare |
| --- | --- | --- | --- |
| 3/11/2026 | Token GitHub `MIGRAZIONI_GH_TOKEN` su **tutti i repository** di lorentsob | un repo nuovo si migra con il solo push di `siti/<sito>.json`; il token vive solo come secret di `migrazioni` | rinnovo prima della scadenza (90 giorni dalla creazione: data in `stato/_regia.json` quando Lorenzo lo crea) |
| 3/11/2026 | Token dell'agente VPS limitato al solo repo `migrazioni` (Contents RW) | l'agente non può toccare altri repo | stessa scadenza del token della regia |
| 3/11/2026 | desmare verrà spostato nell'account lorentsob | niente token di `desmare1`; `siti/desmare.json` punterà a `lorentsob/...` | prima di `prepara` su desmare: trasferimento fatto? |
| 3/11/2026 | `CLOUDFLARE_WORKERS_TOKEN` allargato con DNS Edit su `lorentso.it` | serve a `prepara` (record di collaudo) | prima di `cutover`/`failover` di ogni sito: DNS Edit + Workers Routes Edit anche sulla zona del sito |
| 3/11/2026 | La risorsa Coolify la crea la regia; policy e backup li fa l'agente | niente `coolify-risorsa.yml` nel sito, niente script a mano | — |
| 3/11/2026 | Registro `rilasci-collaudo` fermo → cancellato dalla regia | il collaudo riparte da zero senza intervento | — |
| 3/11/2026 | Variabili Vercel mancanti in Preview solo segnalate | Lorenzo le imposta nel pannello | quando `prepara` lo scrive in `stato/<sito>.json` |
| 3/11/2026 | 10/11 ore 10: ritiro della risorsa vecchia La Cisterna `bwxkphpx…` | con l'agente attivo: voce `voluto: ritirata` in `vps/registro.json` dopo l'eliminazione in Coolify | promemoria già impostato nel thread di La Cisterna |
