#!/usr/bin/env bash
# Installa (o aggiorna) l'agente sulla VPS. Da leggere prima, poi da lanciare come root sulla VPS:
#   scp -r agente oracle-vps:/tmp/agente && ssh -t oracle-vps 'sudo bash /tmp/agente/installa-agente.sh'
# Chiede il token GitHub (fine-grained, solo repository lorentsob/migrazioni, Contents read/write)
# se non è già in /etc/oracle-migrazioni/env o nella variabile MIGRAZIONI_TOKEN. Il token non viene
# stampato. Alla fine fa un giro in --dry-run e mostra lo stato del timer.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "FAIL lanciare come root (sudo)"; exit 1; }
QUI="$(cd "$(dirname "$0")" && pwd)"
REPO="${MIGRAZIONI_REPO:-lorentsob/migrazioni}"
for f in oracle-migrazioni.py oracle-migrazioni.service oracle-migrazioni.timer; do test -f "$QUI/$f" || { echo "FAIL manca $f"; exit 1; }; done
python3 -m py_compile "$QUI/oracle-migrazioni.py"
test -f /usr/local/lib/oracle-backup/pipeline_contract.py || echo "AVVISO: /usr/local/lib/oracle-backup/pipeline_contract.py non trovato: validate_coverage fallirà"

install -m 0755 "$QUI/oracle-migrazioni.py" /usr/local/bin/oracle-migrazioni.py
install -m 0644 "$QUI/oracle-migrazioni.service" "$QUI/oracle-migrazioni.timer" /etc/systemd/system/
install -d -m 0750 /etc/oracle-migrazioni /var/lib/oracle-migrazioni

if [ ! -f /etc/oracle-migrazioni/env ]; then
  if [ -z "${MIGRAZIONI_TOKEN:-}" ]; then read -r -s -p "Token GitHub per $REPO (non viene mostrato): " MIGRAZIONI_TOKEN; echo; fi
  [[ "$MIGRAZIONI_TOKEN" =~ ^(github_pat_|ghp_)[A-Za-z0-9_]+$ ]] || { echo "FAIL token non nella forma attesa"; exit 1; }
  umask 077; printf 'MIGRAZIONI_REPO=%s\nMIGRAZIONI_TOKEN=%s\nMIGRAZIONI_RAMO=main\n' "$REPO" "$MIGRAZIONI_TOKEN" > /etc/oracle-migrazioni/env
  chmod 0600 /etc/oracle-migrazioni/env; echo "scritto /etc/oracle-migrazioni/env"
else echo "/etc/oracle-migrazioni/env già presente: token invariato"; fi

systemctl daemon-reload
systemctl enable --now oracle-migrazioni.timer > /dev/null
echo "--- prova in dry-run (nessuna modifica) ---"
set -a; . /etc/oracle-migrazioni/env; set +a
python3 -B /usr/local/bin/oracle-migrazioni.py --dry-run || echo "AVVISO: il dry-run ha segnalato errori (vedi sopra)"
echo "--- timer ---"
systemctl list-timers oracle-migrazioni.timer --no-pager | head -3
echo "PASS agente installato. Log: journalctl -u oracle-migrazioni.service -n 30 --no-pager"
