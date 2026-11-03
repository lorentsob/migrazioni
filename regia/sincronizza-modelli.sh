#!/usr/bin/env bash
# Aggiorna modelli/ dalla fonte unica ~/vps-oracle (coolify/templates, verificatore, lista asset).
# Uso, dal Mac, nella radice del repo migrazioni:  regia/sincronizza-modelli.sh [~/vps-oracle]
set -euo pipefail
V="${1:-$HOME/vps-oracle}"; QUI="$(cd "$(dirname "$0")/.." && pwd)"
test -d "$V/coolify/templates" || { echo "FAIL $V/coolify/templates non trovato"; exit 1; }
rsync -a --delete --exclude 'README.md.bak' "$V/coolify/templates/" "$QUI/modelli/"
cp "$V/docs/procedura-migrazione/verifica-sito.sh" "$V/docs/procedura-migrazione/verifica_sito.py" "$V/coolify/scripts/generate-failover-allowlist-config.mjs" "$QUI/modelli/"
cd "$QUI" && git status --short modelli/ && echo "PASS modelli allineati a $V (poi: npm test, commit, push)"
