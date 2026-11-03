#!/usr/bin/env python3
"""Read-only verifier for a migrated Next.js site.

The verifier distinguishes the public edge (EDGE), a direct origin connection
(ORIGIN, optional IP with the site's SNI/Host), and the standby (BACKUP). It
checks bytes and hashes, but deliberately does not claim browser or outage
coverage.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import http.client
import json
import re
import socket
import os
import ssl
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Mapping, Sequence
from urllib.parse import urlsplit, urlunsplit

DEFAULT_PAGES = ("/it", "/en")
STATIC_RE = re.compile(r"/_next/static/[A-Za-z0-9._~/%+?=&:@$,!*\-]+")
SHA_RE = re.compile(r"^[0-9a-fA-F]{7,40}$")
HTML_MARKER_RE = re.compile(r"^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)", re.I)


@dataclass(frozen=True)
class Target:
    label: str
    hostname: str
    connect_host: str
    scheme: str = "https"
    port: int | None = None


@dataclass
class Response:
    status: int | None
    headers: Mapping[str, str] = field(default_factory=dict)
    body: bytes = b""
    error: str | None = None
    tls_verified: bool = False
    cert_expires: float | None = None


class SNIHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection to an IP while validating/SNI-ing the public hostname."""

    def __init__(self, connect_host: str, server_hostname: str, **kwargs):
        super().__init__(connect_host, **kwargs)
        self.server_hostname = server_hostname

    def connect(self):  # pragma: no cover - exercised by TLS integration tests
        sock = socket.create_connection((self.host, self.port), self.timeout, self.source_address)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.server_hostname)


def _header_map(message) -> dict[str, str]:
    if hasattr(message, "getheaders"):
        return {k.lower(): v for k, v in message.getheaders()}
    if hasattr(message, "items"):
        return {k.lower(): v for k, v in message.items()}
    return {}


def _cert_expiry(sock) -> float | None:
    try:
        cert = sock.getpeercert()
        value = cert.get("notAfter") if cert else None
        return ssl.cert_time_to_seconds(value) if value else None
    except (AttributeError, ValueError, TypeError):
        return None


def bypass_headers(hostname: str) -> dict[str, str]:
    """Header di "Protection Bypass for Automation" solo per i deployment *.vercel.app.

    Il segreto arriva da VERCEL_AUTOMATION_BYPASS_SECRET e non va mai ai domini propri.
    """
    secret = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET", "")
    if secret and hostname.lower().endswith(".vercel.app"):
        return {"x-vercel-protection-bypass": secret}
    return {}


def fetch_url(target: Target, path: str, method: str = "GET", timeout: float = 20.0) -> Response:
    """Fetch one HTTPS request with strict certificate validation.

    For ORIGIN, ``target.connect_host`` is the IP but SNI and Host remain the
    public hostname. Redirects are never followed.
    """
    if not path.startswith("/"):
        path = "/" + path
    context = ssl.create_default_context()
    headers = {"User-Agent": "verifica-sito/3", "Cache-Control": "no-cache"}
    if target.connect_host != target.hostname:
        headers["Host"] = target.hostname
    headers.update(bypass_headers(target.hostname))
    connection = None
    try:
        if target.scheme == "http":
            connection = http.client.HTTPConnection(target.connect_host, target.port or 80, timeout=timeout)
        else:
            connection = SNIHTTPSConnection(target.connect_host, target.hostname, port=target.port or 443, context=context, timeout=timeout)
        connection.request(method, path, headers=headers)
        # Capture the peer certificate while the TLS socket is live. Some
        # HTTPResponse implementations detach/close the socket in getresponse.
        cert_expires = _cert_expiry(getattr(connection, "sock", None)) if target.scheme == "https" else None
        response = connection.getresponse()
        body = response.read()
        return Response(response.status, _header_map(response), body, tls_verified=target.scheme == "https", cert_expires=cert_expires)
    except Exception as exc:
        return Response(None, error=f"{type(exc).__name__}: {exc}")
    finally:
        if connection is not None:
            connection.close()


def _clean_asset_url(value: str) -> str | None:
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or not parsed.path.startswith("/_next/static/"):
        return None
    if "#" in value or "\\" in value:
        return None
    return urlunsplit(("", "", parsed.path, parsed.query, ""))


def extract_assets(body: bytes) -> set[str]:
    text = html.unescape(body.decode("utf-8", "replace"))
    assets: set[str] = set()
    for match in STATIC_RE.finditer(text):
        asset = _clean_asset_url(match.group(0))
        if asset:
            assets.add(asset)
    return assets


def _is_html_or_error(path: str, response: Response) -> bool:
    content_type = response.headers.get("content-type", "").lower()
    if "text/html" in content_type or "application/xhtml" in content_type:
        return True
    if re.search(r"\.(?:m?js|css)(?:$|\?)", path, re.I):
        sample = response.body[:512].decode("utf-8", "replace")
        if HTML_MARKER_RE.search(sample) or "service temporarily unavailable" in sample.lower():
            return True
    return False


def _sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


COMMIT_KEYS = {"revision", "commit", "sourceCommit"}


def _explicit_commit_values(value) -> Iterable[str]:
    if isinstance(value, Mapping):
        for key, child in value.items():
            if key in COMMIT_KEYS and isinstance(child, str):
                yield child
            yield from _explicit_commit_values(child)
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for child in value:
            yield from _explicit_commit_values(child)


def health_ok(body: bytes, expected: str | None = None) -> tuple[bool, str]:
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return False, f"JSON non valido: {exc}"
    if not isinstance(payload, Mapping) or payload.get("status") != "ok":
        return False, "status non e' ok"
    if not expected:
        return True, "status ok"
    if not SHA_RE.fullmatch(expected):
        return False, "commit atteso deve essere SHA completo o prefisso di almeno 7 caratteri"
    strings = sorted({s.lower() for s in _explicit_commit_values(payload) if SHA_RE.fullmatch(s)})
    if len(expected) == 40:
        return (expected.lower() in {s.lower() for s in strings}, f"commit {expected}")
    matches = [s for s in strings if s.lower().startswith(expected.lower())]
    if len(matches) != 1:
        return False, f"prefisso {expected} non univoco nel JSON health ({len(matches)} corrispondenze)"
    return True, f"commit {matches[0]}"


def load_manifest(path: str | Path) -> dict[str, tuple[str, int]]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError("manifest deve essere un oggetto JSON")
    if payload.get("schema") == "cisterna-assets/v1":
        entries = payload.get("assets")
        if not isinstance(entries, list):
            raise ValueError("manifest helper assets deve essere una lista")
        relative_paths = True
    elif payload.get("version") == 1:
        entries = payload.get("files")
        if not isinstance(entries, list):
            raise ValueError("manifest storico files deve essere una lista")
        relative_paths = False
    else:
        raise ValueError("schema manifest non supportato; servono cisterna-assets/v1 o version=1/files")
    if not entries:
        raise ValueError("manifest vuoto: nessuna prova di copertura o integrita'")
    cleaned: dict[str, tuple[str, int]] = {}
    for entry in entries:
        if not isinstance(entry, Mapping):
            raise ValueError("voce manifest non valida")
        path_value = str(entry.get("path", ""))
        if relative_paths and not path_value.startswith("/"):
            path_value = "/_next/static/" + path_value
        expected_hash = entry.get("sha256")
        expected_size = entry.get("size")
        if not isinstance(expected_hash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", expected_hash):
            raise ValueError(f"hash manifest obbligatorio/non valido: {path_value}")
        if isinstance(expected_size, bool) or not isinstance(expected_size, int) or expected_size < 0:
            raise ValueError(f"size manifest obbligatoria/non valida: {path_value}")
        asset = _clean_asset_url(path_value)
        if not asset:
            raise ValueError(f"asset manifest non canonico: {path_value}")
        if asset in cleaned:
            raise ValueError(f"asset manifest duplicato: {asset}")
        cleaned[asset] = (expected_hash.lower(), expected_size)
    return cleaned


def _emit(lines: list[str], ok: bool, label: str, detail: str = "") -> None:
    lines.append(f"{'PASS' if ok else 'FAIL'} {label}" + (f" ({detail})" if detail else ""))


def run_verification(
    domain: str,
    backup: str = "",
    commit: str = "",
    *,
    pages: Sequence[str] = DEFAULT_PAGES,
    asset_page: str | None = None,
    health_path: str = "/api/health",
    staging: bool = False,
    origin_ip: str | None = None,
    manifest: str | Path | None = None,
    timeout: float = 20.0,
    request: Callable[[Target, str, str, float], Response] = fetch_url,
) -> tuple[int, str]:
    domain = domain.strip()
    backup = backup.strip()
    pages = tuple(p if p.startswith("/") else "/" + p for p in pages if p)
    targets = [Target("EDGE", domain, domain)]
    if origin_ip:
        targets.append(Target("ORIGIN", domain, origin_ip))
    if backup:
        targets.append(Target("BACKUP", backup, backup))
    lines: list[str] = []
    failures = 0
    cert_seen: set[str] = set()
    unreachable: dict[str, str] = {}
    responses: dict[tuple[str, str, str], Response] = {}

    def get(target: Target, path: str, method: str = "GET") -> Response:
        nonlocal failures
        key = (target.label, method, path)
        if key not in responses:
            responses[key] = request(target, path, method, timeout)
        result = responses[key]
        if result.status is None:
            unreachable.setdefault(target.label, result.error or "errore rete/TLS")
            return result
        if target.label not in cert_seen and result.status is not None:
            cert_seen.add(target.label)
            if result.tls_verified:
                _emit(lines, True, f"{target.label} certificato hostname/catena verificati")
                if result.cert_expires is not None:
                    days = int((result.cert_expires - datetime.now(timezone.utc).timestamp()) // 86400)
                    valid_date = days >= 20
                    _emit(lines, valid_date, f"{target.label} certificato scadenza", f"{days} giorni")
                    failures += not valid_date
                else:
                    _emit(lines, False, f"{target.label} certificato scadenza", "data di scadenza non disponibile")
                    failures += 1
            else:
                _emit(lines, False, f"{target.label} certificato", "TLS non verificato")
                failures += 1
        return result

    # One connection preflight per target prevents a dead endpoint from
    # multiplying the timeout across pages, health and assets.
    for target in targets:
        preflight = get(target, "/", "HEAD")
        if preflight.status is None:
            _emit(lines, False, f"{target.label} target raggiungibile", unreachable[target.label])
            failures += 1

    for target in targets:
        if target.label in unreachable:
            lines.append(f"SKIP {target.label} pagine/health (target irraggiungibile)")
            continue
        for page in pages:
            result = get(target, page)
            ok = result.status == 200
            _emit(lines, ok, f"{target.label} pagina {page}", f"HTTP {result.status}" if result.status else (result.error or "errore rete"))
            failures += not ok
            if result.status is None:
                _emit(lines, False, f"{target.label} target raggiungibile", unreachable[target.label])
                failures += 1
                lines.append(f"SKIP {target.label} controlli dipendenti (target irraggiungibile)")
                break
        if target.label in unreachable:
            continue
        health = get(target, health_path)
        health_pass = health.status == 200
        detail = f"HTTP {health.status}" if health.status else (health.error or "errore rete")
        if health_pass:
            content_type = health.headers.get("content-type", "").lower()
            if "json" not in content_type:
                health_pass, detail = False, f"content-type non JSON: {content_type or 'assente'}"
            else:
                health_pass, detail = health_ok(health.body, commit or None)
        _emit(lines, health_pass, f"{target.label} health", detail)
        failures += not health_pass

    for path in ("/sitemap.xml", "/robots.txt"):
        if targets[0].label in unreachable:
            lines.append(f"SKIP EDGE {path} (target irraggiungibile)")
            continue
        result = get(targets[0], path)
        ok = result.status == 200
        _emit(lines, ok, f"EDGE {path}", f"HTTP {result.status}" if result.status else (result.error or "errore rete"))
        failures += not ok

    if not staging and targets[0].label not in unreachable:
        for source, expected in ((f"http://{domain}/", f"https://{domain}"), (f"https://www.{domain}/", f"https://{domain}")):
            scheme, _, host_path = source.partition("://")
            host, _, path = host_path.partition("/")
            result = request(Target("EDGE", host, host, scheme), "/" + path, "GET", timeout)
            location = result.headers.get("location", "")
            parsed_location = urlsplit(location)
            ok = (result.status in (301, 302, 307, 308) and parsed_location.scheme == "https" and
                  parsed_location.hostname == domain and parsed_location.port in (None, 443))
            _emit(lines, ok, f"redirect {source}", f"HTTP {result.status} -> {location or '-'}")
            failures += not ok
    elif staging:
        lines.append("SKIP redirect www/http (staging)")
    else:
        lines.append("SKIP redirect www/http (EDGE irraggiungibile)")

    asset_sets: dict[str, set[str]] = {}
    asset_pages = (asset_page,) if asset_page else pages
    for target in targets:
        if target.label in unreachable:
            lines.append(f"SKIP {target.label} asset HTML (target irraggiungibile)")
            asset_sets[target.label] = set()
            continue
        combined: set[str] = set()
        for page in asset_pages:
            result = get(target, page)
            if result.status == 200:
                combined.update(extract_assets(result.body))
        asset_sets[target.label] = combined
        _emit(lines, bool(combined), f"{target.label} asset HTML", f"{len(combined)} asset")
        failures += not bool(combined)

    def compare(source: Target, destination: Target) -> None:
        nonlocal failures
        if source.label in unreachable or destination.label in unreachable:
            lines.append(f"SKIP asset {source.label} -> {destination.label} (target irraggiungibile)")
            return
        if not asset_sets[source.label]:
            _emit(lines, False, f"asset {source.label} -> {destination.label}", "non testato: nessun asset nell'HTML")
            failures += 1
            return
        missing = 0
        different = 0
        invalid = 0
        first = ""
        for asset in sorted(asset_sets[source.label]):
            left = get(source, asset)
            right = get(destination, asset)
            if left.status != 200 or right.status != 200:
                missing += 1
                first = first or f"{asset} HTTP {left.status}/{right.status}"
                continue
            if _is_html_or_error(asset, left) or _is_html_or_error(asset, right):
                invalid += 1
                first = first or f"{asset} HTML/error page"
                continue
            if _sha256(left.body) != _sha256(right.body):
                different += 1
                first = first or f"{asset} hash diverso"
        ok = missing == different == invalid == 0
        detail = f"{len(asset_sets[source.label])} asset, mancanti {missing}, hash diversi {different}, HTML/error {invalid}"
        if first:
            detail += f", es. {first}"
        _emit(lines, ok, f"asset {source.label} -> {destination.label}", detail)
        failures += not ok

    for index, source in enumerate(targets):
        for destination in targets[index + 1:]:
            compare(source, destination)
            compare(destination, source)

    if manifest:
        try:
            entries = load_manifest(manifest)
            manifest_hashes_by_target: dict[str, dict[str, tuple[str, int] | None]] = {}
            for target in targets:
                if target.label in unreachable:
                    lines.append(f"SKIP manifest asset {target.label} (target irraggiungibile)")
                    continue
                bad = 0
                actuals: dict[str, tuple[str, int] | None] = {}
                for asset, (expected_hash, expected_size) in entries.items():
                    result = get(target, asset)
                    actual = (_sha256(result.body), len(result.body)) if result.status == 200 else None
                    actuals[asset] = actual
                    if (result.status != 200 or _is_html_or_error(asset, result) or actual is None or
                            actual[0] != expected_hash or actual[1] != expected_size):
                        bad += 1
                manifest_hashes_by_target[target.label] = actuals
                _emit(lines, bad == 0, f"manifest asset {target.label}", f"{len(entries) - bad}/{len(entries)} verificati")
                failures += bad != 0
            available_targets = [target for target in targets if target.label not in unreachable]
            if len(available_targets) > 1:
                baseline = manifest_hashes_by_target[available_targets[0].label]
                mismatches = sum(1 for asset in entries if any(manifest_hashes_by_target[t.label].get(asset) != baseline.get(asset) for t in available_targets[1:]))
                _emit(lines, mismatches == 0, "manifest hash incrociati", f"{len(entries) - mismatches}/{len(entries)} identici")
                failures += mismatches != 0
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            _emit(lines, False, "manifest", str(exc))
            failures += 1

    for target in targets:
        if target.label not in cert_seen and target.label not in unreachable:
            _emit(lines, False, f"{target.label} certificato", "nessuna risposta HTTPS verificabile")
            failures += 1
    lines.append("Non verificato: browser, cookie, navigazione client, guasto reale, posta, CMS, richieste escluse dal failover.")
    lines.append("ESITO: " + ("PASS" if failures == 0 else "FAIL"))
    return (1 if failures else 0), "\n".join(lines) + "\n"


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("domain")
    parser.add_argument("backup", nargs="?", default="")
    parser.add_argument("commit", nargs="?", default="")
    parser.add_argument("--pages", nargs="+", default=list(DEFAULT_PAGES))
    parser.add_argument("--asset-page")
    parser.add_argument("--health", default="/api/health")
    parser.add_argument("--staging", action="store_true")
    parser.add_argument("--origin-ip")
    parser.add_argument("--manifest")
    parser.add_argument("--timeout", type=float, default=20.0)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    status, output = run_verification(
        args.domain, args.backup, args.commit, pages=args.pages, asset_page=args.asset_page,
        health_path=args.health, staging=args.staging, origin_ip=args.origin_ip,
        manifest=args.manifest, timeout=args.timeout,
    )
    print(output, end="")
    return status


if __name__ == "__main__":
    raise SystemExit(main())
