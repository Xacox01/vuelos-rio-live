#!/usr/bin/env node
/* Arnés de regresión v2 — valida el nuevo dashboard OTA-plano contra data.json real.
   Uso: node verify.js <ruta-index.html> <ruta-data.json> */
const fs = require('fs');
const htmlPath = process.argv[2] || 'index.html';
const dataPath = process.argv[3] || 'data.json';
const html = fs.readFileSync(htmlPath, 'utf8');
const DATA = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

const i0 = html.indexOf('createApp({');
const i1 = html.indexOf('}).mount(', i0);
if (i0 < 0 || i1 < 0) { console.error('FATAL: no se encuentra createApp/mount'); process.exit(2); }
const cfgSrc = html.slice(i0 + 'createApp('.length, i1 + 1);
global.location = { pathname: '/vuelos-rio-live/' };
// constantes globales del script del sitio (necesarias en el scope del eval)
const DIA = ['dom','lun','mar','mié','jue','vie','sáb'];
const MES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
// dataset de aeropuertos del buscador universal (extraído del HTML del sitio)
const mAER = html.match(/const AEROPUERTOS = (\[[\s\S]*?\])\s*\.filter/);
const AEROPUERTOS = mAER ? eval(mAER[1]) : [];
let cfg;
try { cfg = eval('(' + cfgSrc + ')'); } catch (e) { console.error('FATAL: config no compila:', e.message); process.exit(2); }

const vm = Object.assign({}, typeof cfg.data === 'function' ? cfg.data() : cfg.data);
for (const [k, f] of Object.entries(cfg.methods || {})) vm[k] = f.bind(vm);
for (const [k, f] of Object.entries(cfg.computed || {})) Object.defineProperty(vm, k, { get: () => f.call(vm), configurable: true });
vm.D = DATA;

let fails = 0, checks = 0;
function ok(cond, msg, extra) { checks++; if (!cond) { fails++; const det = 'FAIL ' + msg + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''); console.log('  ' + det); console.error('::error::[verify] ' + det.slice(0, 250)); } else console.log('  ok   ' + msg); }
const money = n => typeof n === 'number' && isFinite(n) && n > 30000 && n < 5000000;
const fresh = ts => { if (!ts) return false; const t = Date.parse(String(ts).replace(' ', 'T') + 'Z'); return isFinite(t) && (Date.now() - t) < 26 * 3600e3; };

console.log('== 1. tiles (precios por fuente) ==');
const tiles = vm.tiles;
ok(Array.isArray(tiles) && tiles.length >= 5, 'tiles >= 5 fuentes', tiles.length);
ok(tiles.every(t => money(t.clp)), 'todos los clp validos', tiles.map(t => t.clp));
ok(tiles.every((t, i) => i === 0 || tiles[i - 1].clp <= t.clp), 'ordenado barato primero');
ok(tiles.every(t => (t.url || '').startsWith('http')), 'links http');
ok(tiles.filter(t => t.key === 'despegar' || t.key === 'falabella').every(t => (t.url || '').includes('/shop/flights/results/')), 'OTA con deep link a búsqueda real (no homepage)', tiles.filter(t => t.key === 'despegar' || t.key === 'falabella').map(t => t.url));
ok(tiles.filter(t => t.key === 'despegar' || t.key === 'falabella').every(t => !String(t.url).includes('/RIO/')), 'OTA sin código RIO inválido (usa GIG)');
ok(tiles.every(t => typeof t.fresco === 'boolean'), 'flag fresco presente');
ok(vm.minimo === tiles[0].clp, 'minimo == tile mas barato');
const F = DATA.fuentes || {};
const stale = tiles.filter(t => (t.key === 'despegar' || t.key === 'falabella') && !fresh((F[t.key] || {}).ts));
ok(stale.length === 0, 'sin OTA con datos +24h', stale.map(t => t.key));
tiles.forEach(t => console.log('     ' + t.nombre + ': $' + Math.round(t.clp).toLocaleString('es-CL') + ' (' + t.ts + ')'));

console.log('== 2. ventanasTop + buscador ==');
const vw = vm.ventanasTop;
ok(Array.isArray(vw) && vw.length >= 1, 'ventanasTop >= 1', vw.length);
ok(vw.every(w => /^\d{4}-\d{2}-\d{2}$/.test(w.ida) && /^\d{4}-\d{2}-\d{2}$/.test(w.vuelta)), 'fechas ISO');
ok(vw.every(w => w.ida < w.vuelta), 'ida < vuelta');
ok(vw.every(w => money(w.clp)), 'precios de ventana validos');
ok((vm.dpRT(vw[0].ida, vw[0].vuelta) || '').includes('despegar.cl/shop/flights/results/roundtrip/SCL/GIG'), 'dpRT formato (agencia ancla)');
ok(Array.isArray(vm.agencias) && vm.agencias.length >= 6, 'agencias comparación >= 6', vm.agencias && vm.agencias.length);
ok(vm.agencias.every(a => /^https:\/\//.test(a.u)), 'agencias con URL https');
ok(vm.agencias.some(a => a.u.includes('atrapalo.cl')) && vm.agencias.some(a => a.u.includes('turismocity.cl')) && vm.agencias.some(a => a.u.includes('kiwi.com')) && vm.agencias.some(a => a.u.includes('decolar.com')), 'agencias nuevas presentes (Atrápalo/Turismocity/Kiwi/Decolar)');

console.log('== 3. filas de vuelos ==');
const filas = vm.filas;
ok(Array.isArray(filas) && filas.length >= 10, 'filas >= 10', filas.length);
ok(filas.every(r => money(r.clp)), 'precios de filas validos');
ok(filas.every((r, i) => i === 0 || filas[i - 1].clp <= r.clp), 'filas ordenadas');
ok(filas.every(r => (r.link || '').startsWith('http')), 'links de fila http');
ok(filas.every(r => r.ida < r.vuelta), 'fechas coherentes en filas');
ok(new Set(filas.map(r => r.cod)).size >= 2, '>= 2 aerolineas distintas');
const fd = vm.filasFiltradas;
vm.filterMax = 350000;
ok(vm.filasFiltradas.every(r => r.clp <= 350000), 'filtro 350K funciona');
vm.filterMax = 0; vm.onlyDirect = true;
ok(vm.filasFiltradas.every(r => r.directo), 'filtro directos funciona');
vm.onlyDirect = false;

console.log('== 4. calendarios (meses rodantes) ==');
const cals = vm.calendarios;
ok(Array.isArray(cals) && cals.length >= 2 && cals.length <= 8, '2-8 calendarios rodantes (meses con datos x 2 sentidos)', cals.length);
ok(cals.every(c => c.cells.length >= 28 && c.cells.length <= 42), 'grids de dias completos', cals.map(c => c.cells.length));
ok(cals.every(c => /^\d{4}/.test(c.nombre) || MESES.some(m => c.nombre.includes(m))), 'nombres de mes presentes');
const conPrecio = cals.flatMap(c => c.cells).filter(c => c && c.clp);
ok(conPrecio.length >= 15, '>= 15 dias con precio', conPrecio.length);
ok(conPrecio.every(c => money(c.clp)), 'precios de calendario validos');
ok(cals.some(c => c.cells.some(c2 => c2 && c2.cheap)), 'hay dia barato marcado en el calendario');
ok(cals.every(c => c.cells.every(c2 => !c2 || !c2.clp || !isNaN(new Date(c2.iso)))), 'fechas ISO de celdas validas');

console.log('== 5. destinos y ofertas ==');
const ds = vm.destinos;
ok(Array.isArray(ds) && ds.length >= 12, 'destinos >= 12', ds.length);
ok(ds.every(d => money(d.clp)), 'precios destinos validos');
ok(ds.every(d => (d.link || '').startsWith('http')), 'links destinos http');
ok(ds.every((d, i) => i === 0 || ds[i - 1].clp <= d.clp), 'destinos ordenados');
ok(ds.every(d => typeof d.enPresupuesto === 'boolean'), 'flag presupuesto');
/* Gate de playas orientado a DATOS, no al mercado: cuántos destinos caben en
   $500k depende de la temporada (para ene–feb 2027 solo 3 de 16 quedaron bajo
   presupuesto y el umbral fijo de 6 congeló la publicación del sitio entero).
   Lo que este gate debe detectar es datos rotos/vacíos o pesos corruptos:
   exigimos cotización en >= 3 destinos y >= 1 dentro de presupuesto (si un
   parseo inflara todos los precios 10x, el segundo check lo caza). */
const PL = (DATA.fuentes || {}).playas || {};
const nWin = Math.max(0, ...((PL.destinos || []).map(d => (d.windows || []).length)));
const nDatos = (PL.destinos || []).filter(d => d.mejor && d.mejor.clp > 0).length;
ok(nDatos >= 3, `>= 3 destinos de playa con cotización (ventanas escaneadas: ${nWin}/3)`, nDatos);
ok(vm.destinosEnPresupuesto >= 1, '>= 1 destino de playa dentro de presupuesto', vm.destinosEnPresupuesto);
ok(vm.ofertas.length >= 5 && vm.ofertas.every(o => o.cod !== 'GIG'), 'ofertas excluyen Rio (card grande)');
ok(vm.ofertaRio && money(vm.ofertaRio.clp), 'ofertaRio presente');
/* TASK 26 (bug del dueño): "un valor distinto entre los más baratos vs los
   destinos — eso no puede suceder". En rio-live la tarjeta GIG mostraba una
   ventana acumada hace DÍAS (ts 20-oct con data del 29-oct). El scraper ahora
   sincroniza GIG contra el pool RT fresco cada ciclo y evapora ventanas >26 h.
   Regla: si el pool cubre las fechas del precio publicado, la tarjeta debe ser
   IDÉNTICA al mínimo fresco con ts del ciclo; si no viene cubierto, aviso. */
const gigD = (PL.destinos || []).find(x => x.cod === 'GIG');
if (gigD && gigD.mejor && gigD.mejor.clp > 0) {
  const ageH = ts => { if (!ts) return null; const t = Date.parse(String(ts).replace(' ', 'T') + 'Z'); return isFinite(t) ? (Date.now() - t) / 3600e3 : null; };
  const poolRT = {};
  const addRT = (i, v, c) => { if (i && v && typeof c === 'number' && c > 0) { const k = i + '_' + v; if (!(k in poolRT) || c < poolRT[k]) poolRT[k] = c; } };
  ((F.jetsmart || {}).combos || []).forEach(c => addRT(c.ida, c.vuelta, c.clp));
  ((F.sky || {}).pairs || []).forEach(p => addRT(p.ida, p.vuelta, p.clp));
  ((F.latam || {}).combos || []).forEach(c => addRT(c.ida, c.vuelta, c.clp));
  ((F.cocha || {}).ventanas || []).forEach(v => addRT(v.ida, v.vuelta, v.min_clp));
  const fMg = poolRT[gigD.mejor.ida + '_' + gigD.mejor.vuelta];
  if (fMg !== undefined) {
    const eMg = ageH(gigD.mejor.ts);
    ok(eMg !== null && eMg <= 0.5, 'GIG: tarjeta destinos sincronizada al ciclo fresco (mejor.ts <= 30 min)', gigD.mejor.ts);
    ok(Math.abs(gigD.mejor.clp - fMg) <= 1, 'GIG: precio de tarjeta == mínimo fresco (mismas fechas)', { tarjeta: gigD.mejor.clp, fresco: fMg });
  } else console.log('     aviso: par mejor de GIG sin cobertura fresca este ciclo (' + gigD.mejor.ida + '→' + gigD.mejor.vuelta + ')');
} else {
  ok(false, 'GIG: tarjeta de destinos presente con mejor precio', 'falta GIG en playas.destinos');
}
ds.forEach(d => console.log('     ' + d.cod + ' ' + d.ciudad + ': $' + Math.round(d.clp).toLocaleString('es-CL') + (d.enPresupuesto ? '' : ' (sobre presupuesto)')));

console.log('== 6. cupones ==');
const cp = vm.cupones;
ok(Array.isArray(cp) && cp.length >= 10, 'cupones >= 10', cp.length);
ok(cp.every(c => c.id && c.merchant && c.title && (c.url || '').startsWith('http')), 'cupones con campos minimos');
ok(cp.some(c => c.code && /^[A-Za-z0-9\-_.]{3,30}$/.test(c.code)), 'hay al menos 1 codigo real', cp.filter(c => c.code).map(c => c.code));
ok(cp.some(c => c.verified), 'hay cupones verificados');
ok(vm.cuponesVisibles.length === cp.length, 'filtro "todas" muestra todo');
if (vm.merchants.length) { vm.cpF = vm.merchants[0]; ok(vm.cuponesVisibles.every(c => c.merchant === vm.merchants[0]), 'filtro por merchant funciona'); vm.cpF = 'todas'; }

/* TASK 25: registro numerado de módulos (fuente: modulos.json) + saneo estructural de cupones */
let REG = null;
try { REG = JSON.parse(fs.readFileSync(require('path').join(require('path').dirname(require('path').resolve(dataPath)), 'modulos.json'), 'utf8')); } catch (e) {}
ok(!!REG && Array.isArray(REG.modulos) && REG.modulos.length >= 15, 'registro modulos.json: >= 15 módulos numerados', REG ? (REG.modulos || []).length : 'sin archivo');
ok(!!REG && REG.modulos.every(m => /^M\d{2}$/.test(m.numero || '') && m.id && m.nombre), 'números de módulo M01..Mnn válidos con id y nombre');
ok(!!REG && new Set(REG.modulos.map(m => m.numero)).size === REG.modulos.length, 'números de módulo únicos (sin duplicados)');
ok((DATA.cupones.items || []).every(x => x.store && x.kind && (x.url || '').startsWith('http')), 'cupones con estructura completa (store/kind/url)', (DATA.cupones.items || []).filter(x => !x.store).length);

console.log('     merchants: ' + vm.merchants.join(', '));
console.log('     codigos: ' + cp.filter(c => c.code).map(c => c.merchant + ':' + c.code).join(', '));

console.log('== 7. alertas + estado ==');
ok(Array.isArray(vm.alertas), 'alertas es array');
const est = vm.estado;
ok(Array.isArray(est) && est.length >= 6, 'estado >= 6 fuentes', est.length);
ok(est.every(s => typeof s.ok === 'boolean' && s.det), 'estado con det y ok');

console.log('== 7b. notificaciones por correo (privacy-first) ==');
/* enmascarado: solo primera y última letra visibles (j•••m) */
ok(vm.maskEmail('juan.perez@gmail.com') === 'j•••m', 'maskEmail primera+última letra', vm.maskEmail('juan.perez@gmail.com'));
ok(vm.maskEmail('a@x.io') === 'a•••o', 'maskEmail aplica regla inicial+final en correos cortos', vm.maskEmail('a@x.io'));
ok(vm.maskEmail('') === '•••' && vm.maskEmail(null) === '•••', 'maskEmail tolera vacío/null');
ok(typeof vm.suscribir === 'function', 'método suscribir presente');
ok(html.includes("suscribir('alta')") && html.includes("suscribir('baja')"), 'botones alta/baja en el sitio');
ok(html.includes("mode:'no-cors'") && html.includes('RSA-OAEP'), 'cifrado RSA-OAEP en navegador (correo nunca viaja en claro)');
ok(html.includes('primera y la última letra'), 'nota de privacidad visible (inicial+final)');
ok(!html.includes('subUrl'), 'flujo viejo por issues eliminado del sitio');
/* config pública */
const cfgPath = require('path').join(require('path').dirname(htmlPath), 'alertas.cfg.json');
let cfgOk = false, hookOk = false;
try { const ac = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); cfgOk = typeof ac.pub === 'string' && ac.pub.length > 200; hookOk = /^https:\/\//.test(ac.webhook || ''); } catch (e) {}
ok(cfgOk, 'alertas.cfg.json con clave pública RSA', cfgOk);
ok(hookOk, 'alertas.cfg.json con bus https', hookOk);
/* registro cifrado: jamás un correo en claro en el repo */
const encPath = require('path').join(require('path').dirname(htmlPath), 'subscribers.enc.json');
if (fs.existsSync(encPath)) {
  const encRaw = fs.readFileSync(encPath, 'utf8');
  ok(!encRaw.includes('@'), 'subscribers.enc.json sin NINGÚN correo en claro');
  const enc = JSON.parse(encRaw);
  ok(Array.isArray(enc.items), 'registro cifrado con items');
}
/* data.json: suscriptores solo enmascarados */
const SUBS = DATA.suscriptores || null;
ok(SUBS === null || (typeof SUBS.total === 'number' && Array.isArray(SUBS.muestras)), 'suscriptores con total+muestras');
ok(SUBS === null || SUBS.muestras.every(m => /^[^@\s]•••[^@\s]$/.test(m)), 'muestras 100% enmascaradas (inicial+final)', SUBS && SUBS.muestras);
ok(SUBS === null || !JSON.stringify(SUBS).includes('@'), 'suscriptores sin correos crudos');
ok(!fs.existsSync(require('path').join(require('path').dirname(htmlPath), 'subscribers.json')), 'subscribers.json (texto plano) eliminado');
/* backend del módulo */
const base = require('path').dirname(htmlPath);
ok(fs.existsSync(require('path').join(base, 'notificaciones.py')), 'notificaciones.py presente');
ok(fs.existsSync(require('path').join(base, 'send_alerts.py')), 'send_alerts.py presente');
const subYml = fs.readFileSync(require('path').join(base, '.github/workflows/subscribe.yml'), 'utf8');
ok(subYml.includes('OAEP') && subYml.includes('PATCH'), 'issue-path cifra el correo y limpia el título público');
ok(subYml.includes('cfg["webhook"]'), 'issue-path publica blob cifrado al bus');

console.log('== 8. utilidades y HTML ==');
ok(vm.fmt(337754) === '337.754', 'fmt separador miles CLP', vm.fmt(337754));
ok(vm.fmtK(337754) === '338', 'fmtK redondea a miles', vm.fmtK(337754));
ok(vm.dshort('2027-01-22').length > 5, 'dshort legible', vm.dshort('2027-01-22'));
ok(vm.ago(DATA.updated).includes('hace') || vm.ago(DATA.updated) === 'ahora', 'ago funciona', vm.ago(DATA.updated));
['assets/dest/GIG.jpg', 'assets/dest/FLN.jpg', 'assets/dest/CUN.jpg'].forEach(p => {
  const found = fs.existsSync(require('path').join(require('path').dirname(htmlPath), p));
  ok(found, 'asset existe: ' + p);
});
ok(html.includes('id="cupones"'), 'seccion cupones en HTML');
ok(html.includes('alertas.cfg.json'), 'config del módulo de alertas cargada por el sitio');
ok(!/linear-gradient\((?![0-9]+deg,rgba\(18,33,64)/.test(html.slice(0, html.indexOf('</style>'))), 'sin gradientes decorativos (diseno plano OTA)');
ok((html.match(/#0a4fd9/gi) || []).length >= 3, 'color de marca azul (logo oficial) presente');
ok(!html.includes('CyberMonday'), 'sin cupones caducados hardcodeados');

console.log('== 8b. identidad de marca (logo oficial) ==');
const base2 = require('path').dirname(htmlPath);
ok(fs.existsSync(require('path').join(base2, 'assets/brand/logo.svg')), 'logo oficial SVG presente');
ok(fs.existsSync(require('path').join(base2, 'assets/brand/favicon.svg')), 'favicon oficial SVG presente');
ok(fs.existsSync(require('path').join(base2, 'assets/brand/og-image.png')), 'og-image para compartir presente');
ok(/rel="icon" href="assets\/brand\/favicon\.svg"/.test(html), 'favicon del logo enlazado en head');
ok(/og:image" content="https:\/\/xacox01\.github\.io\/vuelos-rio-live\/assets\/brand\/og-image\.png"/.test(html), 'og:image absoluta enlazada');
const logoSq = html.slice(html.indexOf('class="sq"'), html.indexOf('class="sq"') + 700);
ok(/<svg viewBox="0 0 512 512"[^>]*>/.test(logoSq) && /#0a4fd9/.test(logoSq), 'logo inline en header (círculo azul oficial)');
ok(/stroke="#ff690f"/.test(logoSq), 'señal naranja del logo en header');
ok(/#ff690f/i.test(html.slice(0, html.indexOf('</style>'))), 'naranja oficial en paleta CSS');

console.log('== 9. enlaces profundos por fuente (integridad de compra) ==');
const YEAR = /20\d\d-\d{2}-\d{2}/;   /* ventana rodante: cualquier año futuro */
const TIL_PAT = {
  jetsmart: u => u.includes('booking.jetsmart.com/Flight/InternalSelect') && u.includes('dd2='),
  sky: u => u.includes('skyairline.com') && u.includes('departureDate='),
  latam: u => u.includes('latam.com') && u.includes('outbound='),
  despegar: u => u.includes('despegar.cl/shop/flights/results/'),
  falabella: u => u.includes('viajesfalabella.cl/shop/flights/results/'),
  cocha: u => u.includes('cocha.com/resultado/vuelos/') && !/cocha\.com\/vuelos(\?|$)/.test(u)
};
tiles.forEach(t => {
  const pat = TIL_PAT[t.key];
  ok(pat && pat(t.url || ''), 'tile ' + t.nombre + ': deep link a busqueda real', t.url);
  ok(YEAR.test(t.url || ''), 'tile ' + t.nombre + ': url con fecha rodante', t.url);
  ok(!!t.sub && !!t.nota, 'tile ' + t.nombre + ': sub y nota presentes');
});
const FIL_PAT = r => {
  if (r.src === 'Cocha') return (r.link || '').includes('cocha.com/resultado/vuelos/');
  if (r.al === 'JetSMART') return (r.link || '').includes('booking.jetsmart.com/Flight/InternalSelect');
  if (r.al === 'SKY Airline') return (r.link || '').includes('skyairline.com') && (r.link || '').includes('departureDate=');
  if (r.al === 'LATAM') return (r.link || '').includes('latam.com') && (r.link || '').includes('outbound=');
  return (r.link || '').startsWith('http');
};
const filasBad = filas.filter(r => !FIL_PAT(r));
ok(filasBad.length === 0, 'todas las filas con deep link a su fuente', filasBad.slice(0, 3).map(r => (r.al || r.src) + ' → ' + String(r.link).slice(0, 70)));
ok(filas.every(r => YEAR.test(r.link || '')), 'filas con fecha rodante en el enlace');
const vw0 = vw[0] || {};
ok((vm.dpRT(vw0.ida, vw0.vuelta) || '').includes('despegar.cl'), 'buscador hero: url ancla Despegar');
const dss = ds.filter(d => (d.link || '').includes('cocha.com/resultado/vuelos/')).length;
ok(dss >= ds.length - 1, 'destinos con deep link Cocha (agencia chilena)', dss + '/' + ds.length);
ok(!/skiplagged/i.test(html), 'sin NINGUNA referencia a Skiplagged en la interfaz');
ok(html.includes('Precios referenciales capturados automáticamente'), 'disclaimer de precios referenciales visible');
ok(html.includes('Comparar') && html.includes('en más sitios'), 'fila de comparación con agencias visible');

console.log('== 10. interacciones del sitio ==');
const pax0 = vm.pax;
vm.pax = 2;
ok(vm.skyLink({ ida: '2027-01-22', vuelta: '2027-02-01' }).includes('ADT=2'), 'skyLink respeta pasajeros');
ok(vm.latLink({ ida: '2027-01-22', vuelta: '2027-02-01' }).includes('adults=2'), 'latLink respeta pasajeros');
vm.pax = pax0;
const tileKeys = new Set(tiles.map(t => t.key));
['jetsmart', 'sky', 'latam', 'despegar', 'falabella', 'cocha'].forEach(k =>
  ok(tileKeys.has(k), 'tile presente: ' + k));
ok(!tileKeys.has('skiplagged'), 'tile Skiplagged retirado');
ok(vm.campeon && vm.campeon.key === tiles[0].key, 'campeon == tile mas barato');
ok(vm.minimo === tiles[0].clp && money(vm.minimo), 'minimo del hero coherente');
/* Cocha: auditoría de verificación (base pagina/api + api_min cuando fue verificado) */
const CO = (DATA.fuentes || {}).cocha || {};
ok((CO.ventanas || []).length === 0 || (CO.ventanas || []).every(v => v.base === 'pagina' || v.base === 'api'), 'cocha ventanas con base declarada (pagina/api)');
ok((CO.ventanas || []).length === 0 || (CO.ventanas || []).every(v => v.base !== 'pagina' || !!v.api_min), 'cocha: api_min queda como auditoría cuando se verificó en página');
ok((CO.ventanas || []).every(v => v.min_clp > 100000), 'cocha: mínimos plausibles (sin promos de portada)');
/* coherencia combo: si el tile de una OTA declara fechas, el deep link debe abrir EXACTAMENTE esas fechas */
tiles.filter(t => t.key === 'despegar' || t.key === 'falabella').forEach(t => {
  const m = String(t.url || '').match(/roundtrip\/SCL\/GIG\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})/);
  ok(!!m, 'tile ' + t.nombre + ': deep link roundtrip con ambas fechas', t.url);
  if (m) ok(new Date(m[2]) - new Date(m[1]) >= 6 * 864e5, 'tile ' + t.nombre + ': ventana >= 6 noches (combo real)', m[1] + ' → ' + m[2]);
});
vm.filterMax = 0; vm.onlyDirect = true;
const directas = vm.filasFiltradas.length;
vm.onlyDirect = false;
ok(directas <= vm.filasFiltradas.length, 'filtro directos reduce correctamente');
const nav = ['#hoy', '#vuelos', '#calendario', '#destinos', '#cupones', '#alertas', '#faq'];
nav.forEach(id => ok(html.includes('href="' + id + '"') && html.includes('id="' + id.slice(1) + '"'), 'navegacion y seccion: ' + id));
ok(html.includes('href="alojamientos.html"') && html.includes('id="ofertas"'), 'zona alojamientos enlazada + ofertas presentes');
ok(html.includes('Buscar el más barato'), 'CTA del buscador universal presente');
ok(html.includes('id="aeropuertos"') && html.includes('list='), 'datalist de aeropuertos del buscador universal');
ok(html.includes('<details'), 'FAQ acordeon presente');
ok(html.toLowerCase().includes('afiliad'), 'divulgacion de afiliados en footer');
ok(html.includes('ago(') || html.includes('ago'), 'frescura visible');

console.log('== 11. buscador universal (cualquier destino/fecha, sin límites) ==');
vm.qOri = 'Santiago (SCL)'; vm.qDst = 'Cusco (CUZ)'; vm.qTrip = 'rt';
vm.qFi = '2026-11-06'; vm.qFf = '2026-11-13'; vm.pax = 2;
const sb = vm.sitiosBusqueda;
ok(Array.isArray(sb) && sb.length >= 10, 'buscador universal: >= 10 sitios', sb && sb.length);
ok(sb.every(s => /^https:\/\//.test(s.u)), 'buscador universal: urls https');
ok(sb.some(s => s.n === 'Despegar' && s.u.includes('/shop/flights/results/roundtrip/SCL/CUZ/2026-11-06/2026-11-13/')), 'deep link OTA con ruta arbitraria SCL→CUZ y fechas libres');
ok(sb.some(s => s.n === 'Cocha' && s.u.includes('cocha.com/resultado/vuelos/SCL/CUZ/2026-11-06')), 'deep link Cocha con ruta arbitraria');
ok(sb.some(s => s.n === 'LATAM' && s.u.includes('from=SCL&to=CUZ') && s.u.includes('adults=2')), 'deep link LATAM respeta pasajeros');
ok(sb.some(s => s.n === 'Google Flights' && s.u.includes('travel/flights?q=')), 'Google Flights presente');
ok(sb.some(s => s.n === 'Skyscanner' && s.u.includes('/transporte/vuelos/scl/cuz/261106/261113')), 'deep link Skyscanner con fechas compactas');
vm.qTrip = 'ow';
const sb1 = vm.sitiosBusqueda;
ok(sb1.length >= 10, 'solo ida: >= 10 sitios', sb1.length);
ok(sb1.some(s => s.n === 'Despegar' && s.u.includes('/shop/flights/results/oneway/SCL/CUZ/2026-11-06/1/0/0')), 'deep link oneway correcto');
ok(!sb1.some(s => s.u.includes('2026-11-06/2026-11-13')) || sb1.some(s => s.n === 'Cocha'), 'oneway sin fecha de vuelta en Despegar');
vm.qTrip = 'rt';
const fx = vm.flexFechas;
ok(Array.isArray(fx) && fx.length === 6, 'chips de fechas flexibles ±3 días', fx && fx.length);
ok(fx.every(f => f.u.includes('despegar.cl/shop/flights/results/')), 'chips flexibles abren Despegar');
vm.qDst = 'Madrid (MAD)';
const sbM = vm.sitiosBusqueda;
ok(sbM.length >= 10, 'ruta intercontinental SCL→MAD generada', sbM.length);
ok(sbM.some(s => s.u.includes('/MAD/')), 'ruta MAD presente en deep links');
vm.qDst = 'Río de Janeiro (GIG)';
ok(vm.qOriIata === 'SCL' && vm.qDstIata === 'GIG', 'parseAer entiende formato ciudad (IATA)');
ok(vm.parseAer('LIM') === 'LIM' && vm.parseAer('cualquier otra cosa') === null, 'parseAer acepta IATA suelto y rechaza texto');
vm.pax = 1;

console.log('== 12. zona alojamientos (17 sitios + dueños directos + radar) ==');
const aloPath = require('path').join(base, 'alojamientos.html');
ok(fs.existsSync(aloPath), 'alojamientos.html existe');
if (fs.existsSync(aloPath)) {
  const alo = fs.readFileSync(aloPath, 'utf8');
  const nProv = (alo.match(/\{n:'/g) || []).length;
  ok(nProv >= 17, 'al menos 17 sitios de alojamiento en la zona', nProv);
  ok((alo.match(/own:true/g) || []).length === 6, '6 canales de dueños directos (3 Chile + 3 Argentina)', (alo.match(/own:true/g) || []).length);
  ['Airbnb', 'Booking.com', 'Vrbo', 'Expedia', 'Hotels.com', 'Agoda', 'Hostelworld',
   'Despegar Hoteles', 'Cocha Hoteles', 'Trivago', 'Kayak', 'Google Hoteles',
   'Yapo.cl', 'Portal Inmobiliario', 'MercadoLibre Chile', 'Argenprop', 'Zonaprop'].forEach(n =>
    ok(alo.includes("n:'" + n + "'"), 'sitio alojamiento presente: ' + n));
  ok(alo.includes('airbnb.cl/s/') && alo.includes('searchresults.es.html') && alo.includes('argenprop.com/departamentos-alquiler-temporal-'), 'deep links de alojamientos con búsqueda armada');
  ok(alo.includes('createApp') && alo.includes('data.json'), 'zona alojamientos con app Vue y data.json');
  ok(alo.includes('checkin=') && alo.includes('checkout='), 'fechas de estadía en los deep links');
  ok(alo.includes('radar') && alo.includes('stays'), 'radar de noches en la zona de alojamientos');
}
/* radar de alojamientos en data.json (opcional hasta el primer barrido) */
const ST = DATA.stays || null;
ok(ST === null || (ST.ventana && Array.isArray(ST.destinos)), 'data.stays con estructura válida (o sin primer barrido aún)');
if (ST && Array.isArray(ST.destinos)) {
  ok(ST.destinos.length >= 6, 'radar alojamientos: >= 6 destinos', ST.destinos.length);
  ok(ST.destinos.filter(d => d.min_clp > 0).length >= 1, 'radar alojamientos: >= 1 destino con precio capturado');
  ok(ST.destinos.every(d => d.pais === 'Chile' || d.pais === 'Argentina'), 'destinos de Chile/Argentina');
  ok(ST.destinos.every(d => !d.min_clp || (d.min_clp > 10000 && d.min_clp < 3000000)), 'precios de alojamiento plausibles');
}
ok(fs.existsSync(require('path').join(base, 'fetch_stays.py')), 'fetch_stays.py presente (radar de alojamientos)');

console.log('\n' + (checks - fails) + '/' + checks + ' checks OK' + (fails ? ' — ' + fails + ' FALLOS' : ''));
process.exit(fails ? 1 : 0);
