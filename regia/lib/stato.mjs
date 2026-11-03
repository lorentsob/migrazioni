// stato/<sito>.json: esito di ogni fase, scritto dalla regia. Claude lo legge via API contenuti.
export const SCHEMA_STATO = 'stato/v1';
export const ORDINE = ['prepara', 'collaudo', 'cutover', 'failover', 'chiudi'];

export function nuovoStato(sito) {
  return { schema: SCHEMA_STATO, sito, fasi: {}, valori: {}, aggiornato: null };
}

/** La fase precedente a `fase` deve essere PASS (prepara non ha precedenti). */
export function precedentePass(stato, fase) {
  const i = ORDINE.indexOf(fase);
  if (i <= 0) return null;
  const prec = ORDINE[i - 1];
  return stato?.fasi?.[prec]?.esito === 'PASS' ? null : prec;
}

export function apriFase(stato, fase, { run, ora }) {
  stato.fasi[fase] = { esito: 'IN_CORSO', inizio: ora, fine: null, run, passi: [], errore: null, attesa: null };
  stato.aggiornato = ora;
  return stato;
}

export function chiudiFase(stato, fase, { esito, errore = null, attesa = null, ora }) {
  const f = stato.fasi[fase];
  Object.assign(f, { esito, fine: ora, errore, attesa });
  stato.aggiornato = ora;
  return stato;
}
