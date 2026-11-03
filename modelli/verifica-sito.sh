#!/usr/bin/env bash
# Compatibilita' con l'interfaccia storica. La logica vive in verifica_sito.py.
# Uso invariato: verifica-sito.sh <dominio> [dominio-backup] [commit-atteso]
# Variabili: PAGINE, HEALTH, STAGING, ORIGIN_IP, MANIFEST.
set -u
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DOM="${1:?dominio richiesto}"
BAK="${2:-}"
COMMIT="${3:-}"
args=("$DOM")
if [ "$BAK" != "" ] || [ "$COMMIT" != "" ]; then args+=("$BAK"); fi
if [ "$COMMIT" != "" ]; then args+=("$COMMIT"); fi
if [ "${PAGINE:-}" != "" ]; then read -r -a page_values <<< "$PAGINE"; args+=(--pages "${page_values[@]}"); fi
if [ "${PAGINA_ASSET:-}" != "" ]; then args+=(--asset-page "$PAGINA_ASSET"); fi
if [ "${HEALTH:-}" != "" ]; then args+=(--health "$HEALTH"); fi
if [ "${STAGING:-0}" = "1" ]; then args+=(--staging); fi
if [ "${ORIGIN_IP:-}" != "" ]; then args+=(--origin-ip "$ORIGIN_IP"); fi
if [ "${MANIFEST:-}" != "" ]; then args+=(--manifest "$MANIFEST"); fi
if [ "$#" -gt 3 ]; then args+=("${@:4}"); fi
exec python3 "$SCRIPT_DIR/verifica_sito.py" "${args[@]}"
