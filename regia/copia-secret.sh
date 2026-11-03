#!/usr/bin/env bash
# Una tantum, dal Mac: mette nel repo di regia i secret usati dalle pipeline (gli stessi di
# lorentsob/cisterna) più il token GitHub della regia. I valori non passano mai per la chat:
#   - se esiste una voce nel Keychain con il nome del secret (security find-generic-password -s NOME),
#     viene letta da lì;
#   - altrimenti il valore viene chiesto a schermo senza eco.
# Uso: regia/copia-secret.sh [owner/migrazioni]   (richiede gh autenticato con accesso al repo)
set -euo pipefail
REPO="${1:-lorentsob/migrazioni}"
NOMI=(MIGRAZIONI_GH_TOKEN VERCEL_TOKEN COOLIFY_TOKEN CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID CLOUDFLARE_WORKERS_TOKEN)
gh repo view "$REPO" --json name > /dev/null || { echo "FAIL repo $REPO non raggiungibile con gh"; exit 1; }
gia="$(gh secret list --repo "$REPO" --json name --jq '.[].name')"
for n in "${NOMI[@]}"; do
  if grep -qx "$n" <<<"$gia" && [ "${SOVRASCRIVI:-}" != 1 ]; then echo "ok     $n già presente (SOVRASCRIVI=1 per rifarlo)"; continue; fi
  v="$(security find-generic-password -s "$n" -w 2>/dev/null || true)"
  if [ -z "$v" ]; then read -r -s -p "$n (invio vuoto = salta): " v; echo; fi
  if [ -z "$v" ]; then echo "SALTO  $n"; continue; fi
  printf '%s' "$v" | gh secret set "$n" --repo "$REPO" && echo "ok     $n impostato"
done
echo "Secret presenti ora:"; gh secret list --repo "$REPO" --json name --jq '.[].name' | sed 's/^/  /'
