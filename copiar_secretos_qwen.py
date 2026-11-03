#!/usr/bin/env python3
"""copiar_secretos_qwen.py — ONE-SHOT de mantenimiento.

Copia los secretos de envío de correo de ESTE repo (vuelos-rio-live) al repo
hermano Xacox01/qwen_vuelos_rio para que los correos funcionen en ambos sitios.

Seguridad:
- Los valores se leen del entorno del runner (nunca de logs) y viajan
  cifrados con la public key del repo destino (libsodium sealed box).
- NUNCA se imprimen valores: solo nombres de secretos y códigos HTTP.
- El token usado es PUSH_TOKEN (mismo que ya usan los workflows para pushear).

Disparo: solo workflow_dispatch (manual, dueño).
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

DEST = "Xacox01/qwen_vuelos_rio"
NOMBRES = ["ALERT_RSA_PRIV", "SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_PORT"]

TOK = (os.environ.get("PUSH_TOKEN") or "").strip()
if not TOK:
    print("::error::PUSH_TOKEN no disponible en este runner")
    sys.exit(1)


def api(url, method="GET", payload=None):
    req = urllib.request.Request(
        url,
        data=None if payload is None else __import__("json").dumps(payload).encode(),
        method=method,
        headers={
            "Authorization": f"token {TOK}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (raw.decode() if raw else "")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="ignore")


# 0) acceso al repo destino
code, body = api(f"https://api.github.com/repos/{DEST}")
if code != 200:
    print(f"::error::sin acceso a {DEST} con PUSH_TOKEN (HTTP {code}) — revisa el scope del token")
    sys.exit(1)

# 1) public key del repo destino
code, body = api(f"https://api.github.com/repos/{DEST}/actions/secrets/public-key")
if code != 200:
    print(f"::error::no se pudo obtener la public key de {DEST} (HTTP {code})")
    sys.exit(1)
import json
pk = json.loads(body)
key_b64, key_id = pk["key"], pk["key_id"]

# 2) sealed box con pynacl
try:
    from nacl import encoding, public
except ImportError:
    print("::error::pynacl no instalada en el runner (agrega pip install pynacl)")
    sys.exit(1)
recip = public.PublicKey(key_b64.encode(), encoding.Base64Encoder())
sealed = public.SealedBox(recip)

# 3) copia
print(f"copiando secretos hacia {DEST} (valores cifrados, jamás impresos):")
for n in NOMBRES:
    val = (os.environ.get(n) or "").strip()
    if not val:
        print(f"  {n}: no existe en este repo — omitido")
        continue
    enc = sealed.encrypt(val.encode("utf-8"))
    code, _ = api(
        f"https://api.github.com/repos/{DEST}/actions/secrets/{n}",
        method="PUT",
        payload={"encrypted_value": base64.b64encode(enc).decode(), "key_id": key_id},
    )
    estado = "copiado OK" if code in (201, 204) else f"ERROR HTTP {code}"
    print(f"  {n} ({len(val)} chars): {estado}")

print("listo — el próximo ciclo de refresh de qwen (≤5 min) detectará los secretos")
