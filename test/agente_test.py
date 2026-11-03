"""Agente VPS con file finti di policy e backup, pipeline_contract finto e comandi finti."""
import json, os, shutil, subprocess, sys, tempfile, unittest, importlib.util

QUI = os.path.dirname(os.path.abspath(__file__))
AGENTE = os.path.join(QUI, "..", "agente", "oracle-migrazioni.py")
RIF = "rifuuid00000000000000000"; NUOVO = "nuovouuid0000000000000000"

CONTRACT = '''
import json, os
def read_json(p):
    with open(p) as f: return json.load(f)
def validate_coverage(cfg):
    apps = os.environ["APPS_DIR"]
    attese = set(cfg["coolify"]["directory_paths"])
    reali = {os.path.join(apps, d) for d in os.listdir(apps)}
    if reali - attese: raise ValueError("cartelle non coperte: %s" % sorted(reali - attese))
    if os.environ.get("FINTO_COPERTURA") == "errore": raise ValueError("copertura finta in errore")
'''

class Ambiente:
    def __init__(self):
        self.d = tempfile.mkdtemp(prefix="agente-")
        self.apps = os.path.join(self.d, "apps"); os.makedirs(os.path.join(self.apps, RIF))
        self.pol = os.path.join(self.d, "runtime-policy.json"); self.bak = os.path.join(self.d, "config.json")
        self.regia = os.path.join(self.d, "regia"); os.makedirs(os.path.join(self.regia, "vps/esiti"))
        self.contract = os.path.join(self.d, "contract"); os.makedirs(self.contract)
        open(os.path.join(self.contract, "pipeline_contract.py"), "w").write(CONTRACT)
        self.bin = os.path.join(self.d, "bin"); os.makedirs(self.bin); self.log = os.path.join(self.d, "cmd.log")
        for n, corpo in {"systemctl": 'echo "systemctl $*" >> "$CMD_LOG"; [ "$1" = is-failed ] && echo "${FINTO_SICUREZZA:-inactive}"; exit 0',
                         "openssl": 'echo "openssl $*" >> "$CMD_LOG"; echo "Verify return code: ${FINTO_CERT:-0 (ok)}"',
                         "docker": 'echo "docker $*" >> "$CMD_LOG"; [ "$1" = ps ] && echo "${FINTO_CONTAINER:-nuovouuid0000000000000000-123}"; exit 0'}.items():
            p = os.path.join(self.bin, n); open(p, "w").write("#!/bin/bash\n" + corpo + "\n"); os.chmod(p, 0o755)
        self.scrivi(self.pol, {"reviewed_apps": [RIF], "restricted_static_apps": [], "retired_apps": []})
        self.scrivi(self.bak, {"source_files": [f"{self.apps}/{RIF}/docker-compose.yaml", f"{self.apps}/{RIF}/.env"], "coolify": {"directory_paths": [f"{self.apps}/{RIF}"]}})
    def scrivi(self, p, d):
        with open(p, "w") as f: json.dump(d, f, indent=2)
    def leggi(self, p):
        with open(p) as f: return json.load(f)
    def registro(self, risorse=(), verifiche=()):
        self.scrivi(os.path.join(self.regia, "vps/registro.json"), {"schema": "vps-registro/v1", "risorse": list(risorse), "verifiche": list(verifiche)})
    def esito(self, nome):
        p = os.path.join(self.regia, "vps/esiti", nome + ".json"); return self.leggi(p) if os.path.exists(p) else None
    def lancia(self, *args, **env):
        e = {**os.environ, "POLICY": self.pol, "BACKUP": self.bak, "CONTRACT_DIR": self.contract, "APPS_DIR": self.apps, "CMD_LOG": self.log,
             "SYSTEMCTL": os.path.join(self.bin, "systemctl"), "OPENSSL": os.path.join(self.bin, "openssl"), "DOCKER": os.path.join(self.bin, "docker"), **env}
        return subprocess.run([sys.executable, "-B", AGENTE, "--regia-dir", self.regia, *args], capture_output=True, text=True, env=e)
    def comandi(self): return open(self.log).read() if os.path.exists(self.log) else ""

VOCE = {"uuid": NUOVO, "sito": "esempio", "riferimento": RIF, "statico": False, "voluto": "registrata", "richiesto": "2026-11-04T10:00:00Z"}

class TestAgente(unittest.TestCase):
    def setUp(self): self.a = Ambiente()
    def tearDown(self): shutil.rmtree(self.a.d)

    def test_registra_quando_la_cartella_esiste(self):
        os.makedirs(os.path.join(self.a.apps, NUOVO)); self.a.registro([VOCE])
        r = self.a.lancia(); self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        e = self.a.esito(NUOVO); self.assertEqual(e["esito"], "PASS"); self.assertIn("3 voci aggiunte", e["dettagli"]); self.assertTrue(e["applicato"])
        pol = self.a.leggi(self.a.pol); self.assertIn(NUOVO, pol["reviewed_apps"]); self.assertNotIn(NUOVO, pol["restricted_static_apps"])
        bak = self.a.leggi(self.a.bak); self.assertIn(f"{self.a.apps}/{NUOVO}", bak["coolify"]["directory_paths"]); self.assertIn(f"{self.a.apps}/{NUOVO}/.env", bak["source_files"])
        self.assertIn("systemctl start oracle-security-alerts.service", self.a.comandi())
        self.assertTrue([f for f in os.listdir(self.a.d) if f.startswith("runtime-policy.json.bak-")], "copia di sicurezza")
        # secondo giro: già coerente, esito invariato (nessuna riscrittura)
        m = os.path.getmtime(os.path.join(self.a.regia, "vps/esiti", NUOVO + ".json"))
        r = self.a.lancia(); self.assertEqual(r.returncode, 0)
        self.assertEqual(self.a.esito(NUOVO)["dettagli"], e["dettagli"]); self.assertEqual(os.path.getmtime(os.path.join(self.a.regia, "vps/esiti", NUOVO + ".json")), m)

    def test_statico_va_anche_in_restricted(self):
        os.makedirs(os.path.join(self.a.apps, NUOVO)); self.a.registro([{**VOCE, "statico": True}])
        self.assertEqual(self.a.lancia().returncode, 0)
        self.assertIn(NUOVO, self.a.leggi(self.a.pol)["restricted_static_apps"])

    def test_attesa_senza_cartella(self):
        self.a.registro([VOCE]); r = self.a.lancia(); self.assertEqual(r.returncode, 0)
        e = self.a.esito(NUOVO); self.assertEqual(e["esito"], "ATTESA"); self.assertIn("non ancora presente", e["dettagli"])
        self.assertNotIn(NUOVO, self.a.leggi(self.a.pol)["reviewed_apps"])

    def test_controllo_fallito_rimette_i_file(self):
        os.makedirs(os.path.join(self.a.apps, NUOVO)); self.a.registro([VOCE])
        prima_pol, prima_bak = open(self.a.pol).read(), open(self.a.bak).read()
        r = self.a.lancia(FINTO_SICUREZZA="failed"); self.assertEqual(r.returncode, 1)
        e = self.a.esito(NUOVO); self.assertEqual(e["esito"], "FAIL"); self.assertIn("oracle-security-alerts failed", e["dettagli"]); self.assertIn("rimessi come prima", e["dettagli"])
        self.assertEqual(open(self.a.pol).read(), prima_pol); self.assertEqual(open(self.a.bak).read(), prima_bak)
        r = self.a.lancia(FINTO_COPERTURA="errore"); self.assertEqual(self.a.esito(NUOVO)["esito"], "FAIL"); self.assertEqual(open(self.a.bak).read(), prima_bak)

    def test_ritiro_solo_dopo_che_la_cartella_sparisce(self):
        os.makedirs(os.path.join(self.a.apps, NUOVO)); self.a.registro([VOCE]); self.a.lancia()
        self.a.registro([{**VOCE, "voluto": "ritirata", "motivo": "prova"}])
        self.a.lancia(); self.assertEqual(self.a.esito(NUOVO)["esito"], "ATTESA"); self.assertIn("eliminare prima la risorsa in Coolify", self.a.esito(NUOVO)["dettagli"])
        shutil.rmtree(os.path.join(self.a.apps, NUOVO)); r = self.a.lancia(); self.assertEqual(r.returncode, 0, r.stdout)
        e = self.a.esito(NUOVO); self.assertEqual(e["esito"], "PASS"); self.assertIn("voci tolte", e["dettagli"])
        pol = self.a.leggi(self.a.pol); self.assertNotIn(NUOVO, pol["reviewed_apps"]); self.assertEqual(pol["retired_apps"], [{"uuid": NUOVO, "reason": "prova"}])
        self.assertNotIn(NUOVO, json.dumps(self.a.leggi(self.a.bak)))

    def test_dry_run_non_scrive(self):
        os.makedirs(os.path.join(self.a.apps, NUOVO)); self.a.registro([VOCE], [{"id": "v1", "tipo": "certificato", "dominio": "x.lorentso.it"}])
        r = self.a.lancia("--dry-run"); self.assertEqual(r.returncode, 0); self.assertIn("dry-run", r.stdout)
        self.assertIsNone(self.a.esito(NUOVO)); self.assertIsNone(self.a.esito("v1")); self.assertNotIn(NUOVO, self.a.leggi(self.a.pol)["reviewed_apps"])
        self.assertNotIn("openssl", self.a.comandi())

    def test_verifica_certificato_pass_fail_e_una_sola_volta(self):
        v = {"id": "esempio-cert-1", "tipo": "certificato", "dominio": "collaudo-esempio.lorentso.it", "richiesto": "x", "scade": "2999-01-01T00:00:00+00:00"}
        self.a.registro([], [v]); self.assertEqual(self.a.lancia().returncode, 0)
        e = self.a.esito("esempio-cert-1"); self.assertEqual(e["esito"], "PASS"); self.assertIn("0 (ok)", e["dettagli"])
        self.assertIn("-servername collaudo-esempio.lorentso.it", self.a.comandi())
        self.a.lancia(FINTO_CERT="21 (unable)"); self.assertEqual(self.a.esito("esempio-cert-1")["esito"], "PASS", "non si riesegue")
        self.a.registro([], [{**v, "id": "esempio-cert-2"}]); self.a.lancia(FINTO_CERT="21 (unable to verify)")
        self.assertEqual(self.a.esito("esempio-cert-2")["esito"], "FAIL")
        self.a.registro([], [{**v, "id": "vecchia", "scade": "2020-01-01T00:00:00+00:00"}]); self.a.lancia()
        self.assertEqual(self.a.esito("vecchia")["esito"], "SCADUTA")

    def test_verifica_pausa_mette_in_pausa_e_riprende(self):
        self.a.registro([], [{"id": "p1", "tipo": "pausa", "uuid": NUOVO, "secondi": 10, "scade": "2999-01-01T00:00:00+00:00"}])
        r = self.a.lancia(); self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.a.esito("p1")["esito"], "PASS")
        c = self.a.comandi(); self.assertIn(f"docker pause {NUOVO}-123", c); self.assertIn(f"docker unpause {NUOVO}-123", c)
        self.a.registro([], [{"id": "p2", "tipo": "pausa", "uuid": NUOVO, "secondi": 9999}]); self.a.lancia()
        self.assertEqual(self.a.esito("p2")["esito"], "FAIL"); self.assertIn("durata", self.a.esito("p2")["dettagli"])

    def test_voci_non_valide_ignorate_e_registro_assente(self):
        r = self.a.lancia(); self.assertEqual(r.returncode, 0); self.assertIn("registro assente", r.stdout)
        self.a.registro([{"uuid": "../etc", "voluto": "registrata"}, {"uuid": NUOVO, "voluto": "esplodi"}])
        r = self.a.lancia(); self.assertEqual(r.returncode, 1); self.assertEqual(r.stdout.count("voce non valida"), 2)

if __name__ == "__main__": unittest.main()
