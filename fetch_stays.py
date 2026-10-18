#!/usr/bin/env python3
"""Radar de ALOJAMIENTOS (Chile y Argentina) — fase 1 en vivo.

Ingeniería inversa reutilizada del módulo de vuelos:
  1. Egress por Cloudflare WARP (wireproxy, ver warp_boot.sh) → IP de consumidor.
  2. Navegador Firefox stealth real (Camoufox) con humanize + geoip.
  3. URL-ONLY-RESULTS: solo se aceptan lecturas que aterrizan en la página de
     resultados del sitio (guard de redirección, igual que en vuelos).
  4. Captura de API interna + DOM con rango de plausibilidad de ALOJAMIENTO
     (los precios de hotels APIs llegan como montos totales en CLP).

Sitios capteados en vivo (fase 1):
  · Despegar Hoteles (despegar.cl/hoteles)  — mismo WAF DataDome que vuelos
  · Booking.com (searchresults)             — best-effort anti-bot

El resto de los 17 sitios del comparador del sitio se entrega como deep links
exactos (la búsqueda ya armada); sus precios sin sesión de usuario no son
fiables y NO se inventan: la regla del sitio es publicar solo lo capturable.

Salida: data.json["stays"] (merge con la corrida anterior, rotación por ciclo).
"""
import json
import os
import re
import time

try:
    from camoufox.sync_api import Camoufox
    HAS_CAMOUFOX = True
except Exception:
    HAS_CAMOUFOX = False

import fetch_otas  # reutiliza helpers probados (challenge, diag, decision)

OTA_PROXY = os.environ.get("OTA_PROXY", "").strip()
VIA = "camoufox+warp" if OTA_PROXY else "camoufox"
DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")

# Rango de plausibilidad de ALOJAMIENTO en CLP por estancia (3 noches):
# desde hospedajes económicos hasta premium. Evita contaminación con miles/fechas.
STAY_MIN, STAY_MAX = 15000, 2500000

# Ventana de búsqueda: próximo fin de semana largo (viernes → lunes), 2 adultos.
import datetime as _dt
_hoy = _dt.date.today()
_dias_a_viernes = (4 - _hoy.weekday()) % 7          # lunes=0 ... viernes=4
CHECKIN = (_hoy + _dt.timedelta(days=_dias_a_viernes or 7)).isoformat()
CHECKOUT = (_dt.date.fromisoformat(CHECKIN) + _dt.timedelta(days=3)).isoformat()
NOCHES = 3

# Destinos Chile + Argentina (slug despegar, nombre, país, texto Booking).
# Orden intercalado CL/AR para que el primer barrido cubra ambos países.
STAYS_DEST = [
    ("la-serena", "La Serena", "Chile", "La Serena"),
    ("bariloche", "San Carlos de Bariloche", "Argentina", "San Carlos de Bariloche"),
    ("pucon", "Pucón", "Chile", "Pucón"),
    ("mendoza", "Mendoza", "Argentina", "Mendoza"),
    ("puerto-varas", "Puerto Varas", "Chile", "Puerto Varas"),
    ("mar-del-plata", "Mar del Plata", "Argentina", "Mar del Plata"),
    ("vina-del-mar", "Viña del Mar", "Chile", "Viña del Mar"),
    ("buenos-aires", "Buenos Aires", "Argentina", "Buenos Aires"),
    ("valdivia", "Valdivia", "Chile", "Valdivia"),
    ("san-pedro-de-atacama", "San Pedro de Atacama", "Chile", "San Pedro de Atacama"),
]

JS_STAY_EXTRACT = """
() => {
  const out = new Set();
  const re = /[$]\\s?(\\d{1,3}(?:\\.\\d{3})+)/g;
  const t = document.body ? document.body.innerText : '';
  let m;
  while ((m = re.exec(t))) {
    const v = parseInt(m[1].replace(/\\./g, ''), 10);
    if (v >= %d && v <= %d) out.add(v);
  }
  return Array.from(out).sort((a, b) => a - b);
}
""" % (STAY_MIN, STAY_MAX)


class StayCapture:
    """Captura JSON de APIs de hoteles con rango de plausibilidad de estadía."""

    FARE_RE = re.compile(r'"(?:amount|total|price|fare|value)"\s*:\s*"?(\d{4,8})"?')
    API_URL_RE = re.compile(r"(search|hotel|results|cluster|availab)", re.I)

    def __init__(self, max_bodies=40):
        self.bodies = []
        self.max = max_bodies

    def clear(self):
        self.bodies = []

    def on_response(self, r):
        try:
            ct = (r.headers or {}).get("content-type", "")
            u = r.url or ""
            if "json" not in ct or not self.API_URL_RE.search(u):
                return
            if len(self.bodies) >= self.max:
                return
            body = r.text()
            if body and len(body) < 3_000_000:
                self.bodies.append((u[:180], body))
        except Exception:
            pass

    def prices(self):
        vals = []
        for _, body in self.bodies:
            for m in self.FARE_RE.finditer(body):
                try:
                    v = int(m.group(1))
                except ValueError:
                    continue
                if STAY_MIN < v < STAY_MAX:
                    vals.append(v)
        return vals


def _decide(api_vals, dom_vals, log, name):
    """Regla de publicación: API interna > DOM con ≥6 valores plausibles."""
    api_min = min(api_vals) if api_vals else None
    dom_min = min(dom_vals) if dom_vals else None
    if api_min:
        return api_min, "api", {"n_api": len(api_vals), "dom_min": dom_min}
    if dom_min and len(dom_vals) >= 6:
        return dom_min, "dom", {"n_dom": len(dom_vals), "api_min": None}
    log(f"{name}: SIN precio verificable (api={len(api_vals)}, dom={len(dom_vals)})")
    return None, "sin_dato", {"n_api": len(api_vals), "n_dom": len(dom_vals)}


def scan_despegar_hoteles(pg, cap, slug, nombre, log):
    """Despegar Hoteles: misma infraestructura de bypass DataDome que vuelos."""
    url = (f"https://www.despegar.cl/hoteles/search?destination={slug}"
           f"&checkin={CHECKIN}&checkout={CHECKOUT}&adults=2&rooms=1&distribution=2")
    cap.clear()
    try:
        r = pg.goto(url, timeout=60000, wait_until="domcontentloaded")
        status = getattr(r, "status", 0) or 0
        pg.wait_for_timeout(8000)
        vals = _wait_stay_prices(pg, 40000)
        if not vals and not fetch_otas.page_alive(pg):
            fetch_otas.snap_diag(pg, "stays_dp", slug, log)
            vals = _wait_stay_prices(pg, 45000)
        if not vals and fetch_otas.page_alive(pg):
            try:
                pg.reload(timeout=60000, wait_until="domcontentloaded")
                pg.wait_for_timeout(5000)
                vals = _wait_stay_prices(pg, 30000)
            except Exception:
                pass
        url_final = str(pg.url)[:220]
        if "/hoteles/search" not in url_final:
            log(f"despegar-hoteles {slug}: REDIRECCIÓN fuera de resultados ({url_final[:80]})")
            return None
        api_vals = cap.prices()
        mejor, base, det = _decide(api_vals, vals, log, f"despegar-hoteles {slug}")
        if mejor:
            log(f"despegar-hoteles {slug}: ${mejor:,} [{base}] (dom {det.get('n_dom', 0)}, api {det.get('n_api', 0)})")
        return {"min_clp": mejor, "base": base, "status": status, "via": VIA, **det} if mejor else None
    except Exception as e:
        log(f"despegar-hoteles {slug}: ERR {str(e)[:80]}")
        return None


def scan_booking(pg, slug, nombre, pais, log):
    """Booking.com: best-effort (anti-bot propio); guard por URL de resultados."""
    url = (f"https://www.booking.com/searchresults.es.html?ss={nombre.replace(' ', '+')}"
           f"&checkin={CHECKIN}&checkout={CHECKOUT}&group_adults=2&no_rooms=1&group_children=0"
           f"&selected_currency=CLP&lang=es")
    try:
        r = pg.goto(url, timeout=60000, wait_until="domcontentloaded")
        status = getattr(r, "status", 0) or 0
        pg.wait_for_timeout(9000)
        vals = _wait_stay_prices(pg, 35000)
        url_final = str(pg.url)[:220]
        if "searchresults" not in url_final:
            log(f"booking {slug}: sin resultados reales ({url_final[:80]})")
            return None
        if not vals or len(vals) < 5:
            log(f"booking {slug}: lectura insuficiente ({len(vals)} valores)")
            return None
        mejor = min(vals)
        log(f"booking {slug}: ${mejor:,} [dom {len(vals)} valores]")
        return {"min_clp": mejor, "base": "dom", "status": status, "via": VIA, "n_dom": len(vals)}
    except Exception as e:
        log(f"booking {slug}: ERR {str(e)[:80]}")
        return None


def _wait_stay_prices(pg, max_ms=40000):
    t0 = time.time()
    best = []
    while (time.time() - t0) * 1000 < max_ms:
        try:
            vals = pg.evaluate(JS_STAY_EXTRACT) or []
        except Exception:
            vals = []
        if len(vals) > len(best):
            best = vals
        if len(best) >= 6:
            return best
        pg.wait_for_timeout(2500)
    return best


def fetch_stays(log=print):
    """Escanea el lote de este ciclo y devuelve dict {slug: lectura}."""
    if not HAS_CAMOUFOX:
        raise RuntimeError("camoufox no disponible")
    kwargs = {"headless": True, "humanize": True}
    if OTA_PROXY:
        kwargs["proxy"] = {"server": OTA_PROXY}
        kwargs["geoip"] = True
        log(f"Camoufox (stays) saldrá por proxy WARP: {OTA_PROXY} (geoip activado)")
    prev = {}
    try:
        prev = (json.load(open(DATA, encoding="utf8")).get("stays") or {}).get("destinos") or {}
    except Exception:
        prev = {}
    prev_by_slug = {d["slug"]: d for d in prev if isinstance(d, dict) and d.get("slug")}

    # Rotación con presupuesto de tiempo: el escaneo OTA (DataDome) puede correr
    # en el mismo ciclo; si le toca, el barrido de alojamientos se reduce para no
    # exceder el timeout del job de Actions.
    ota_due = True
    try:
        import datetime
        d0 = json.load(open(DATA, encoding="utf8"))
        t = datetime.datetime.strptime(str(d0.get("ota_ts",""))[:19], "%Y-%m-%d %H:%M:%S")
        gap = int(os.environ.get("OTAS_GAP", "9000"))
        ota_due = (datetime.datetime.now() - t).total_seconds() >= gap
    except Exception:
        ota_due = True
    if not prev_by_slug:
        n_first = 2 if ota_due else 6
        lote = STAYS_DEST[:n_first]
        log(f"stays: PRIMER BARRIDO de {len(lote)} destinos (OTA_due={ota_due})")
    else:
        try:
            cycle = int(json.load(open(DATA, encoding="utf8")).get("cycle", 0))
        except Exception:
            cycle = 0
        i0 = cycle % len(STAYS_DEST)
        n_lot = 2 if ota_due else 4
        lote = [STAYS_DEST[(i0 + k) % len(STAYS_DEST)] for k in range(n_lot)]
        log(f"stays: lote rotativo {[s for s, *_ in lote]} (cycle {cycle}, OTA_due={ota_due})")

    out = {}
    cap = StayCapture()
    with Camoufox(**kwargs) as br:
        pg = br.new_page()
        try:
            pg.on("response", cap.on_response)
        except Exception:
            log("API capture no disponible (solo DOM)")
        for slug, nombre, pais, bk_ss in lote:
            dp = scan_despegar_hoteles(pg, cap, slug, nombre, log)
            time.sleep(4.0)
            bkn = scan_booking(pg, slug, nombre, pais, log)
            time.sleep(3.0)
            cands = [x["min_clp"] for x in (dp, bkn) if x and x.get("min_clp")]
            out[slug] = {"slug": slug, "nombre": nombre, "pais": pais,
                         "despegar": dp, "booking": bkn,
                         "min_clp": min(cands) if cands else None,
                         "fuentes": len(cands), "ts": time.strftime("%Y-%m-%d %H:%M:%S")}
    return out, prev_by_slug


def main():
    if os.environ.get("STAYS_FORCE") != "1":
        try:
            d = json.load(open(DATA, encoding="utf8"))
            ts = str((d.get("stays") or {}).get("ts") or "")
            import datetime
            t = datetime.datetime.strptime(ts[:19], "%Y-%m-%d %H:%M:%S")
            gap = int(os.environ.get("STAYS_GAP", "21600"))
            due = (datetime.datetime.now() - t).total_seconds() >= gap
        except Exception:
            due = True
        if not due:
            print("stays: datos vigentes (menos de STAYS_GAP) — omitido")
            return

    fresh, prev_by_slug = fetch_stays()
    d = json.load(open(DATA, encoding="utf8"))
    # merge: destinos no escaneados este ciclo conservan su última lectura
    merged = {slug: dd for slug, dd in prev_by_slug.items() if slug not in fresh}
    merged.update({dd["slug"]: dd for dd in fresh.values()})
    orden = sorted(merged.values(), key=lambda x: (x.get("min_clp") is None, x.get("min_clp") or 1 << 60))
    d["stays"] = {"ts": time.strftime("%Y-%m-%d %H:%M:%S"), "ok": any(x.get("min_clp") for x in fresh.values()),
                  "ventana": {"checkin": CHECKIN, "checkout": CHECKOUT,
                              "noches": NOCHES, "adultos": 2},
                  "nota": ("Tarifas por noche de ALOJAMIENTO capturadas en vivo (2 adultos, estancia del fin de semana "
                           "próximo) en Despegar Hoteles y Booking.com con navegador real + WARP. "
                           "El total exacto lo confirma el sitio al reservar."),
                  "destinos": orden}
    tmp = DATA + ".tmp"
    with open(tmp, "w", encoding="utf8") as fh:
        json.dump(d, fh, ensure_ascii=False)
    os.replace(tmp, DATA)
    n_ok = sum(1 for x in fresh.values() if x.get("min_clp"))
    print(f"stays: {n_ok}/{len(fresh)} destinos con precio este ciclo · total en radar: {len(orden)}")


if __name__ == "__main__":
    main()
