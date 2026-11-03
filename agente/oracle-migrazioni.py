#!/usr/bin/env python3
"""Agente VPS della regia migrazioni (modalità pull, ogni 5 minuti dal timer systemd).

Legge vps/registro.json dal repository di regia (API contenuti GitHub, token limitato a quel
repository), confronta lo stato voluto con quello reale della VPS e applica:
  - risorse "registrata": uuid in reviewed_apps (e restricted_static_apps se statico) della policy,
    voci della risorsa di riferimento duplicate nel backup; poi validate_coverage e
    oracle-security-alerts. Se un controllo fallisce rimette i file come prima.
    Stesso codice di coolify/scripts/registra-risorsa-vps.sh (provato il 3/11).
  - risorse "ritirata": percorso inverso (ritira-risorsa-vps.sh), solo se la cartella
    /data/coolify/applications/<uuid> non esiste più.
  - verifiche: "certificato" (openssl verso 127.0.0.1:443 con SNI) e "pausa" (docker pause del
    container per N secondi, poi unpause), una sola volta per id e solo entro "scade".
Scrive l'esito in vps/esiti/<uuid|id>.json. Non riceve comandi arbitrari: tocca solo
runtime-policy.json e config.json del backup. Nessun segreto nei log.

Uso: oracle-migrazioni.py [--dry-run] [--regia-dir DIR]
  --regia-dir: legge registro.json e scrive esiti/ in una cartella locale (test, prove a mano)
  --dry-run:   stampa cosa farebbe, non scrive nulla (né sulla VPS né nella regia)
Variabili: MIGRAZIONI_REPO (es. lorentsob/migrazioni), MIGRAZIONI_TOKEN, MIGRAZIONI_RAMO (main),
  POLICY, BACKUP, CONTRACT_DIR, APPS_DIR, SYSTEMCTL, DOCKER, OPENSSL, STATO_DIR (percorsi per i test).
"""
import argparse, base64, json, os, shutil, subprocess, sys, time, urllib.request, urllib.error
from datetime import datetime, timezone

POL = os.environ.get("POLICY", "/etc/oracle-security/runtime-policy.json")
BAK = os.environ.get("BACKUP", "/etc/oracle-backup/config.json")
CONTRACT_DIR = os.environ.get("CONTRACT_DIR", "/usr/local/lib/oracle-backup")
APPS_DIR = os.environ.get("APPS_DIR", "/data/coolify/applications")
SYSTEMCTL = os.environ.get("SYSTEMCTL", "systemctl")
DOCKER = os.environ.get("DOCKER", "docker")
OPENSSL = os.environ.get("OPENSSL", "openssl")
STATO_DIR = os.environ.get("STATO_DIR", "/var/lib/oracle-migrazioni")
PAUSA_MAX = 300
UUID_OK = lambda u: isinstance(u, str) and u.isalnum() and u.islower() and 20 <= len(u) <= 40

def ora(): return datetime.now(timezone.utc).isoformat(timespec="seconds")
def log(*a): print(ora(), *a, flush=True)

# ---------- regia: GitHub o cartella locale ----------
class RegiaGitHub:
    def __init__(self, repo, token, ramo="main"):
        self.repo, self.token, self.ramo = repo, token, ramo
    def _req(self, metodo, path, corpo=None):
        req = urllib.request.Request(f"https://api.github.com/repos/{self.repo}/contents/{path}" + ("" if corpo else f"?ref={self.ramo}"),
            data=json.dumps(corpo).encode() if corpo else None, method=metodo)
        req.add_header("Authorization", f"Bearer {self.token}"); req.add_header("Accept", "application/vnd.github+json")
        req.add_header("X-GitHub-Api-Version", "2022-11-28"); req.add_header("User-Agent", "oracle-migrazioni/1")
        if corpo: req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as r: return r.status, json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            return e.code, {}
    def leggi(self, path):
        st, j = self._req("GET", path)
        if st == 404: return None, None
        if st != 200: raise RuntimeError(f"regia: lettura {path} HTTP {st}")
        return json.loads(base64.b64decode(j["content"]).decode()), j["sha"]
    def scrivi(self, path, oggetto, messaggio, sha=None):
        corpo = {"message": messaggio, "branch": self.ramo, "content": base64.b64encode((json.dumps(oggetto, indent=2) + "\n").encode()).decode()}
        if sha: corpo["sha"] = sha
        st, _ = self._req("PUT", path, corpo)
        if st not in (200, 201): raise RuntimeError(f"regia: scrittura {path} HTTP {st}")

class RegiaLocale:
    def __init__(self, cartella): self.c = cartella
    def leggi(self, path):
        p = os.path.join(self.c, path)
        if not os.path.exists(p): return None, None
        with open(p) as f: return json.load(f), "locale"
    def scrivi(self, path, oggetto, messaggio, sha=None):
        p = os.path.join(self.c, path); os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f: json.dump(oggetto, f, indent=2); f.write("\n")

# ---------- stato reale della VPS ----------
def leggi_json(p):
    with open(p) as f: return json.load(f)
def scrivi_json(p, d):
    with open(p, "w") as f: json.dump(d, f, indent=2); f.write("\n")

def stato_reale(uuid):
    pol, bak = leggi_json(POL), leggi_json(BAK)
    return {
        "reviewed": uuid in pol.get("reviewed_apps", []),
        "restricted": uuid in pol.get("restricted_static_apps", []),
        "retired": any(r.get("uuid") == uuid for r in pol.get("retired_apps", [])),
        "backup": uuid in json.dumps(bak),
        "cartella": os.path.isdir(os.path.join(APPS_DIR, uuid)),
    }

def coerente(voce, reale):
    if voce["voluto"] == "registrata":
        return reale["reviewed"] and reale["restricted"] == bool(voce.get("statico")) and reale["backup"] and not reale["retired"]
    return reale["retired"] and not reale["reviewed"] and not reale["restricted"] and not reale["backup"]

# ---------- controlli dopo una modifica (come negli script del 3/11) ----------
def controlli():
    sys.path.insert(0, CONTRACT_DIR)
    import importlib; c = importlib.import_module("pipeline_contract")
    c.validate_coverage(c.read_json(BAK))
    subprocess.run([SYSTEMCTL, "start", "oracle-security-alerts.service"], check=False)
    r = subprocess.run([SYSTEMCTL, "is-failed", "oracle-security-alerts.service"], capture_output=True, text=True).stdout.strip()
    if r == "failed": raise RuntimeError("oracle-security-alerts failed")
    return "copertura backup ok, oracle-security-alerts " + (r or "ok")

def con_copie(azione):
    """Esegue azione() con copie di sicurezza di policy e backup; se fallisce rimette i file."""
    t = time.strftime("%Y%m%d%H%M%S"); copie = {p: f"{p}.bak-{t}" for p in (POL, BAK)}
    for p, c in copie.items(): shutil.copy2(p, c)
    try:
        return azione()
    except Exception as e:
        for p, c in copie.items(): shutil.copy2(c, p)
        raise RuntimeError(f"{e} - file rimessi come prima")

def registra(uuid, rif, statico):
    def azione():
        d = leggi_json(POL)
        d["reviewed_apps"] = sorted(set(d["reviewed_apps"]) | {uuid})
        if statico: d["restricted_static_apps"] = sorted(set(d.get("restricted_static_apps", [])) | {uuid})
        else: d["restricted_static_apps"] = [x for x in d.get("restricted_static_apps", []) if x != uuid]
        d["retired_apps"] = [r for r in d.get("retired_apps", []) if r.get("uuid") != uuid]
        scrivi_json(POL, d)
        cfg = leggi_json(BAK); aggiunte = []; presenti = []
        def sost(x): return json.loads(json.dumps(x).replace(rif, uuid))
        def giro(x):
            if isinstance(x, list):
                for el in list(x):
                    if rif in json.dumps(el):
                        cp = sost(el); (presenti if cp in x else aggiunte).append(cp)
                        if cp not in x: x.append(cp)
                    else: giro(el)
            elif isinstance(x, dict):
                for k in list(x):
                    if rif in k:
                        k2 = k.replace(rif, uuid); (presenti if k2 in x else aggiunte).append(k2)
                        if k2 not in x: x[k2] = sost(x[k])
                    else: giro(x[k])
        giro(cfg)
        if not aggiunte and not presenti: raise RuntimeError(f"nessuna voce del backup cita il riferimento {rif}")
        scrivi_json(BAK, cfg)
        return f"policy reviewed_apps{' + restricted_static_apps' if statico else ''}; backup: {len(aggiunte)} voci aggiunte, {len(presenti)} già presenti; " + controlli()
    return con_copie(azione)

def ritira(uuid, motivo):
    def azione():
        d = leggi_json(POL)
        for k in ("reviewed_apps", "restricted_static_apps"): d[k] = [x for x in d.get(k, []) if x != uuid]
        rit = d.setdefault("retired_apps", [])
        if not any(r.get("uuid") == uuid for r in rit): rit.append({"uuid": uuid, "reason": motivo})
        scrivi_json(POL, d)
        cfg = leggi_json(BAK); tolte = []
        def giro(x):
            if isinstance(x, list):
                for el in list(x):
                    if uuid in json.dumps(el): x.remove(el); tolte.append(el)
                    else: giro(el)
            elif isinstance(x, dict):
                for k in list(x):
                    if uuid in k: del x[k]; tolte.append(k)
                    else: giro(x[k])
        giro(cfg); scrivi_json(BAK, cfg)
        return f"policy retired_apps; backup: {len(tolte)} voci tolte; " + controlli()
    return con_copie(azione)

# ---------- verifiche ----------
def verifica_certificato(dominio):
    if not all(c.isalnum() or c in ".-" for c in dominio): raise RuntimeError("dominio non valido")
    r = subprocess.run([OPENSSL, "s_client", "-connect", "127.0.0.1:443", "-servername", dominio, "-verify_hostname", dominio, "-verify_return_error"],
        input="", capture_output=True, text=True, timeout=30)
    righe = [l for l in (r.stdout + r.stderr).splitlines() if "Verify return code" in l or "notAfter" in l]
    ok = any("Verify return code: 0 (ok)" in l for l in righe)
    return ok, "; ".join(righe) or f"openssl exit {r.returncode}"

def verifica_pausa(uuid, secondi):
    secondi = int(secondi)
    if not UUID_OK(uuid) or not 10 <= secondi <= PAUSA_MAX: raise RuntimeError(f"pausa: uuid o durata non validi (10-{PAUSA_MAX} s)")
    out = subprocess.run([DOCKER, "ps", "--filter", f"name={uuid}", "--format", "{{.Names}}"], capture_output=True, text=True, check=True).stdout.split()
    if len(out) != 1: raise RuntimeError(f"pausa: container di {uuid} non unico ({len(out)})")
    nome = out[0]
    subprocess.run([DOCKER, "pause", nome], check=True, capture_output=True)
    try: time.sleep(secondi)
    finally: subprocess.run([DOCKER, "unpause", nome], check=True, capture_output=True)
    return True, f"container {nome} in pausa {secondi} s, poi ripreso"

# ---------- giro principale ----------
def giro(regia, dry_run=False):
    registro, _ = regia.leggi("vps/registro.json")
    if not registro: log("registro assente: niente da fare"); return 0
    if registro.get("schema") != "vps-registro/v1": log("registro di schema sconosciuto: niente da fare"); return 1
    errori = 0
    for voce in registro.get("risorse", []):
        u = voce.get("uuid")
        if not UUID_OK(u) or voce.get("voluto") not in ("registrata", "ritirata"): log("voce non valida ignorata"); errori += 1; continue
        reale = stato_reale(u)
        esito_prec, sha = regia.leggi(f"vps/esiti/{u}.json")
        esito = {"uuid": u, "sito": voce.get("sito"), "voluto": voce["voluto"], "richiesto": voce.get("richiesto"), "reale": reale}
        if coerente(voce, reale):
            if esito_prec and esito_prec.get("esito") == "PASS" and esito_prec.get("voluto") == voce["voluto"]: continue  # esito già scritto, niente da cambiare
            esito.update(esito="PASS", dettagli="già coerente (stato trovato sulla VPS)", applicato=ora())
        elif voce["voluto"] == "registrata" and not reale["cartella"]:
            esito.update(esito="ATTESA", dettagli=f"cartella {APPS_DIR}/{u} non ancora presente (deploy Coolify non fatto?)", applicato=None)
        elif voce["voluto"] == "ritirata" and reale["cartella"]:
            esito.update(esito="ATTESA", dettagli=f"cartella {APPS_DIR}/{u} ancora presente: eliminare prima la risorsa in Coolify", applicato=None)
        elif dry_run:
            esito.update(esito="DRY_RUN", dettagli=f"farei: {voce['voluto']}", applicato=None); log("dry-run", u, voce["voluto"], reale)
        else:
            try:
                rif = voce.get("riferimento")
                if voce["voluto"] == "registrata":
                    if not UUID_OK(rif): raise RuntimeError("riferimento non valido")
                    det = registra(u, rif, bool(voce.get("statico")))
                else:
                    det = ritira(u, str(voce.get("motivo") or f"ritirata dalla regia ({voce.get('sito')})")[:200])
                esito.update(esito="PASS", dettagli=det, applicato=ora(), reale=stato_reale(u)); log("PASS", voce["voluto"], u)
            except Exception as e:
                esito.update(esito="FAIL", dettagli=str(e), applicato=None); errori += 1; log("FAIL", voce["voluto"], u, e)
        if not dry_run: scrivi_se_diverso(regia, f"vps/esiti/{u}.json", esito, esito_prec, sha, f"esito VPS {u}: {esito['esito']}")
    for ver in registro.get("verifiche", []):
        vid = ver.get("id", "")
        if not vid or not all(c.isalnum() or c in "-_." for c in vid): log("verifica senza id valido ignorata"); continue
        prec, sha = regia.leggi(f"vps/esiti/{vid}.json")
        if prec and prec.get("esito") in ("PASS", "FAIL", "SCADUTA"): continue
        esito = {"id": vid, "tipo": ver.get("tipo"), "richiesto": ver.get("richiesto")}
        try:
            if ver.get("scade") and ver["scade"] < ora(): esito.update(esito="SCADUTA", dettagli="richiesta scaduta, non eseguita")
            elif dry_run: esito.update(esito="DRY_RUN", dettagli=f"farei: {ver.get('tipo')}"); log("dry-run verifica", vid)
            elif ver.get("tipo") == "certificato": ok, det = verifica_certificato(ver["dominio"]); esito.update(esito="PASS" if ok else "FAIL", dettagli=det)
            elif ver.get("tipo") == "pausa": ok, det = verifica_pausa(ver["uuid"], ver.get("secondi", 120)); esito.update(esito="PASS", dettagli=det)
            else: esito.update(esito="FAIL", dettagli=f"tipo sconosciuto: {ver.get('tipo')}")
        except Exception as e:
            esito.update(esito="FAIL", dettagli=str(e)); errori += 1
        esito["eseguito"] = ora(); log("verifica", vid, esito["esito"])
        if not dry_run: regia.scrivi(f"vps/esiti/{vid}.json", esito, f"esito verifica {vid}: {esito['esito']}", sha)
    return errori

def scrivi_se_diverso(regia, path, nuovo, prec, sha, messaggio):
    chiavi = ("uuid", "voluto", "richiesto", "reale", "esito", "dettagli", "applicato")
    if prec and all(prec.get(k) == nuovo.get(k) for k in chiavi): return
    nuovo["aggiornato"] = ora()
    regia.scrivi(path, nuovo, messaggio, sha)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--regia-dir")
    a = ap.parse_args()
    if a.regia_dir: regia = RegiaLocale(a.regia_dir)
    else:
        repo, token = os.environ.get("MIGRAZIONI_REPO"), os.environ.get("MIGRAZIONI_TOKEN")
        if not repo or not token: print("FAIL servono MIGRAZIONI_REPO e MIGRAZIONI_TOKEN (o --regia-dir)"); return 2
        regia = RegiaGitHub(repo, token, os.environ.get("MIGRAZIONI_RAMO", "main"))
    try: errori = giro(regia, a.dry_run)
    except Exception as e: log("FAIL giro:", e); return 1
    return 1 if errori else 0

if __name__ == "__main__": sys.exit(main())
