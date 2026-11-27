/* ------------------------- Pick'em: se resuelve solo -------------------------
   Corre con el cron (cada 5 minutos, solo durante el torneo):
     1) lee las partidas SoloQ de la cuenta del torneo y el rango (API de Riot),
     2) anota el rango más alto y la foto del rango al terminar cada semana y el torneo,
     3) calcula las respuestas de cada ronda y la tabla, y la guarda para la web. Cada persona
        vale por su mejor ronda (porcentaje de aciertos); los empates se sortean en vivo.
   Necesita el secreto RIOT_API_KEY. Sin él no hace nada y lo deja anotado.

     /api/pickem-tabla                    pública: tabla y respuestas ya resueltas
     /api/cuenta                          pública: nombre, rango, ganadas y perdidas de la cuenta del torneo
     /api/pickem-estado                   pública: si hay clave de Riot y qué dio la última prueba
     /api/pickem-datos?key=ADMIN_KEY      lo que leyó de Riot. Con &q18=12&q19=s se cargan a mano
                                          las dos que dependen de la tabla oficial del torneo.

   Antes del torneo el mismo cron prueba la clave con la cuenta del torneo y anota el resultado
   (se escribe solo si cambia, y una vez por día). */
import { RONDAS, preguntasDe, tramoDe } from "./pickem.js";

export const INICIO = Date.parse("2026-11-30T21:00:00Z");       // 30/11 18:00 ARG
export const FIN = Date.parse("2026-12-20T21:00:00Z");          // 20/12 18:00 ARG
// Partidas que cuentan en cada ronda: desde que cierra para responder hasta el domingo
export const TRAMOS = {
  r1: { desde: Date.parse("2026-12-02T21:00:00Z"), hasta: Date.parse("2026-12-07T03:00:00Z") }, // 2/12 18:00 a fin del 6/12
  r2: { desde: Date.parse("2026-12-07T21:00:00Z"), hasta: Date.parse("2026-12-14T03:00:00Z") }, // 7/12 18:00 a fin del 13/12
  r3: { desde: Date.parse("2026-12-14T21:00:00Z"), hasta: FIN },                                // 14/12 18:00 a 20/12 18:00
  final: { desde: INICIO, hasta: FIN }
};
const FIJA = 6 * 3600000;              // pasado este rato, las respuestas de una ronda quedan fijas
// En las de número se suma quedando dentro de este margen (la página muestra el mismo)
export const MARGENES = { q02: 2, q11: 2, q36: 10, q43: 10, q14: 25, q18: 2 };   // solo las de escribir
const CUENTA = "TE LA SACO#SB6";
const CONOCIDA = "OTK Azmeyn#OTK";    // cuenta que ya existe, solo para probar la clave
const PLATAFORMA = "la2";
const COLA = 420;                      // SoloQ
const NUEVAS_POR_VUELTA = 8;           // la vuelta del cron comparte con los tickets las 50 llamadas del plan gratis
const A_MANO = ["q18", "q19"];
const MARGEN = 10 * 60000;             // Riot puede tardar unos minutos en mostrar la última partida

const TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER"];
const DIVS = ["IV", "III", "II", "I"];

export const normal = (s) => String(s || "").normalize("NFD").toLowerCase().replace(/[^a-z]/g, "");

// Posición en la lista de la página: 0 Platino o menos, 1-4 Esmeralda, 5-8 Diamante, 9 Maestro, 10 Gran Maestro, 11 Retador
export function indiceRango(r) {
  if (!r || !r.tier) { return null; }
  const t = TIERS.indexOf(r.tier);
  if (t < 0) { return null; }
  if (t <= 4) { return 0; }
  if (t === 5) { return 1 + DIVS.indexOf(r.div); }
  if (t === 6) { return 5 + DIVS.indexOf(r.div); }
  return t + 2;
}
// Para saber cuál es más alto
export function altura(r) {
  if (!r || !r.tier) { return -1; }
  const t = TIERS.indexOf(r.tier);
  return t * 100000 + (t >= 7 ? 0 : DIVS.indexOf(r.div) * 1000) + (r.lp || 0);
}

async function riot(env, host, ruta) {
  const r = await fetch("https://" + host + ".api.riotgames.com" + ruta, { headers: { "X-Riot-Token": env.RIOT_API_KEY } });
  if (!r.ok) { throw Object.assign(new Error("Riot respondió " + r.status), { status: r.status }); }
  return r.json();
}

const rutaCuenta = (cuenta) => {
  const i = cuenta.lastIndexOf("#");
  return "/riot/account/v1/accounts/by-riot-id/" + encodeURIComponent(cuenta.slice(0, i)) + "/" + encodeURIComponent(cuenta.slice(i + 1));
};
// Las dos consultas que necesita el pick'em: que la cuenta exista y que se pueda leer su rango
async function mirarCuenta(env, cuenta) {
  const a = await riot(env, "americas", rutaCuenta(cuenta));
  // Si falla el rango, la cuenta sí existe: el error sale sin código para no confundirlo con un 404 de cuenta
  await riot(env, PLATAFORMA, "/lol/league/v4/entries/by-puuid/" + a.puuid).catch((e) => { throw new Error("rango: " + e.message); });
}

async function campeones(env) {
  try {
    const v = await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json();
    const j = await (await fetch("https://ddragon.leagueoflegends.com/cdn/" + v[0] + "/data/es_AR/champion.json")).json();
    const m = {};
    for (const c of Object.values(j.data)) { m[Number(c.key)] = c.name; }
    return m;
  } catch (e) { return {}; }
}

const vacio = () => ({ puuid: null, partidas: {}, rango: null, maximo: null, antes: {}, fotos: {}, cubierto: {}, resueltas: {}, manual: {}, error: null });

export async function leerDatos(env) {
  const d = Object.assign(vacio(), (await env.CHECKINS.get("pkd:datos", "json")) || {});
  // Las cargadas a mano van en su propia clave: la vuelta del cron nunca las pisa
  d.manual = Object.assign({}, d.manual, (await env.CHECKINS.get("pkd:mano", "json")) || {});
  return d;
}

async function actualizarDatos(env, d, ahora) {
  const cuenta = env.PICKEM_RIOT_ID || CUENTA;
  if (!d.puuid || d.cuenta !== cuenta) {
    const a = await riot(env, "americas", rutaCuenta(cuenta));
    d.puuid = a.puuid; d.cuenta = cuenta;
  }
  // Rango primero: si algo falla después, el rango más alto ya quedó anotado
  const ligas = await riot(env, PLATAFORMA, "/lol/league/v4/entries/by-puuid/" + d.puuid);
  const l = (ligas || []).find((x) => x.queueType === "RANKED_SOLO_5x5");
  d.rango = l ? { tier: l.tier, div: l.rank, lp: l.leaguePoints } : null;
  if (d.rango && ahora >= INICIO && ahora <= FIN + MARGEN && altura(d.rango) > altura(d.maximo)) { d.maximo = d.rango; }
  // Fotos del rango al terminar cada ronda. Se sacan apenas pasa el corte; si la vuelta llega
  // tarde (y ya pudo haber jugado de nuevo), vale lo último visto antes del corte.
  for (const [id, t] of Object.entries(TRAMOS)) {
    if (ahora < t.hasta) { d.antes[id] = d.rango; }
    else if (!d.fotos[id]) {
      // Si llega tarde y no hay nada visto antes del corte, el rango queda sin dato (no se inventa)
      const aTiempo = ahora - t.hasta <= MARGEN * 2;
      d.fotos[id] = { rango: aTiempo ? d.rango : d.antes[id] || null, cuando: new Date(ahora).toISOString() };
    }
  }
  // Riot devuelve de a 100: se piden más páginas mientras todo lo que viene sea desconocido
  const faltan = [];
  for (let desde = 0; desde < 300; desde += 100) {
    const ids = await riot(env, "americas", "/lol/match/v5/matches/by-puuid/" + d.puuid + "/ids?queue=" + COLA +
      "&start=" + desde + "&count=100&startTime=" + Math.floor(INICIO / 1000));
    faltan.push(...ids.filter((id) => !d.partidas[id]));
    if (ids.length < 100 || ids.some((id) => d.partidas[id])) { break; }
  }
  faltan.reverse();                                                  // de la más vieja a la más nueva
  let nombres = null;
  for (const id of faltan.slice(0, NUEVAS_POR_VUELTA)) {
    const info = (await riot(env, "americas", "/lol/match/v5/matches/" + id)).info || {};
    const yo = (info.participants || []).find((p) => p.puuid === d.puuid);
    if (!yo) { continue; }
    if (!nombres) { nombres = await campeones(env); }
    const dur = info.gameDuration || 0;
    d.partidas[id] = {
      ini: info.gameStartTimestamp || info.gameCreation || 0,
      fin: info.gameEndTimestamp || (info.gameStartTimestamp || 0) + dur * 1000,
      dur: dur, remake: dur < 300 || !!yo.gameEndedInEarlySurrender, gano: !!yo.win,
      cid: yo.championId, champ: nombres[yo.championId] || yo.championName, alias: normal(yo.championName),
      k: yo.kills || 0, m: yo.deaths || 0, a: yo.assists || 0, penta: yo.pentaKills || 0,
      pings: yo.enemyMissingPings || 0, robos: yo.objectivesStolen || 0, gris: yo.totalTimeSpentDead || 0
    };
  }
  d.pendientes = Math.max(0, faltan.length - NUEVAS_POR_VUELTA);
  // Una ronda se puede resolver recién cuando se leyeron todas las partidas después de su corte.
  // Si Riot falla antes de llegar acá, no queda marcada.
  for (const [id, t] of Object.entries(TRAMOS)) { if (ahora >= t.hasta && !d.pendientes) { d.cubierto[id] = true; } }
}

// Partidas que cuentan en un tramo, en orden (sin remakes)
export function jugadas(d, desde, hasta) {
  return Object.values(d.partidas).filter((p) => !p.remake && p.ini >= desde && p.fin <= hasta).sort((a, b) => a.ini - b.ini);
}
function racha(lista, gano) {
  let mejor = 0, n = 0;
  for (const p of lista) { n = p.gano === gano ? n + 1 : 0; mejor = Math.max(mejor, n); }
  return mejor;
}
function porCampeon(lista) {
  const m = new Map();
  for (const p of lista) {
    // Se agrupa por número de campeón: el nombre puede venir distinto si falla la lista de nombres
    const c = m.get(p.cid) || { nombre: p.champ, j: 0, g: 0, claves: [] };
    c.j++; if (p.gano) { c.g++; }
    for (const k of [normal(p.champ), p.alias]) { if (k && c.claves.indexOf(k) < 0) { c.claves.push(k); } }
    if (normal(c.nombre) === p.alias) { c.nombre = p.champ; }
    m.set(p.cid, c);
  }
  return m;
}
// Respuesta de campeón: { texto, claves } (puede haber empate)
function mejores(m, valor, filtro) {
  const lista = [...m.entries()].filter(([, c]) => !filtro || filtro(c));
  if (!lista.length) { return null; }
  const top = Math.max(...lista.map(([, c]) => valor(c)));
  const g = lista.filter(([, c]) => valor(c) === top);
  return { texto: g.map(([, c]) => c.nombre).join(" / "), claves: g.flatMap(([, c]) => c.claves) };
}

const siNo = (b) => (b ? "s" : "n");
function deSemana(d, id) {
  const p = jugadas(d, TRAMOS[id].desde, TRAMOS[id].hasta), g = p.filter((x) => x.gano).length, c = porCampeon(p);
  const suma = (k) => p.reduce((a, x) => a + (x[k] || 0), 0);
  const maximo = (valor) => (p.length ? Math.max(...p.map(valor)) : null);
  const alguna = (cumple) => siNo(p.some(cumple));
  return {
    q02: g, q03: p.length, q04: siNo(g > p.length - g), q09: indiceRango(d.fotos[id].rango),
    q05: mejores(c, (x) => x.j), q06: c.size, q07: alguna((x) => x.penta > 0), q08: racha(p, true),
    q11: maximo((x) => x.k), q12: maximo((x) => x.m),
    // semana 2: las de "gano" con campeón se anulan si no ganó ninguna
    q33: siNo(racha(p, true) >= 5), q34: alguna((x) => x.k >= 15), q35: mejores(c, (x) => x.g, (x) => x.g > 0),
    q36: suma("pings"), q37: maximo((x) => Math.round((x.gris || 0) / 60)), q38: Math.round(suma("dur") / 3600),
    // semana 3
    q39: p.length ? siNo(p[p.length - 1].gano) : null, q40: racha(p, false), q41: alguna((x) => x.m === 0),
    q42: alguna((x) => x.robos > 0), q43: suma("m"), q44: maximo((x) => Math.floor(x.dur / 60))
  };
}
function deTorneo(d) {
  const p = jugadas(d, INICIO, FIN), g = p.filter((x) => x.gano).length, c = porCampeon(p), foto = d.fotos.final;
  const suma = (k) => p.reduce((a, x) => a + x[k], 0);
  return {
    q13: indiceRango(foto.rango), q14: foto.rango ? foto.rango.lp : null, q15: indiceRango(d.maximo),
    q16: p.length ? Math.round(g * 100 / p.length) : null, q17: p.length, q20: racha(p, true), q21: racha(p, false),
    q22: mejores(c, (x) => x.j), q23: mejores(c, (x) => x.g / x.j, (x) => x.j >= 5), q24: c.size, q25: suma("penta"),
    q27: p.length ? Math.round((suma("k") + suma("a")) * 10 / Math.max(1, suma("m"))) / 10 : null,
    q28: p.length ? Math.floor(Math.max(...p.map((x) => x.dur)) / 60) : null
  };
}
function calcular(d, id) {
  const todo = id === "final" ? deTorneo(d) : deSemana(d, id), r = {};
  // Solo las preguntas de esa ronda y las que se pudieron resolver
  for (const q of RONDAS.find((x) => x.id === id).preguntas) {
    if (todo[q] !== null && todo[q] !== undefined) { r[q] = todo[q]; }
  }
  return r;
}
const lista = (d, id, ahora) => ahora >= TRAMOS[id].hasta && !!d.fotos[id] && !!d.cubierto[id];

// Devuelve { r1: { q02: respuesta, ... }, ... } solo con las rondas que ya se pueden resolver
export function respuestas(d, ahora) {
  const out = {};
  for (const { id } of RONDAS) {
    if (!d.resueltas[id] && !lista(d, id, ahora)) { continue; }
    const r = Object.assign({}, d.resueltas[id] || calcular(d, id));
    if (id === "final") {
      for (const q of A_MANO) { if (d.manual[q] !== undefined) { r[q] = q === "q18" ? Number(d.manual[q]) : d.manual[q]; } }
    }
    out[id] = r;
  }
  return out;
}

export function acierta(id, tipo, dicha, correcta, ronda) {
  if (tipo === "num") { return Math.abs(Number(dicha) - correcta) <= (MARGENES[id] || 0); }
  if (tipo === "rg") { return tramoDe(id, ronda, correcta) === String(dicha); }
  if (tipo === "camp") { return correcta.claves.includes(dicha); }
  return String(dicha) === String(correcta);
}
// a mejor que b si su porcentaje es mayor (se compara en enteros para que los empates sean exactos)
const comparar = (a, b) => b.aciertos * a.total - a.aciertos * b.total;

// Cada persona vale por su mejor ronda: aciertos sobre las preguntas resueltas de esa ronda
export function puntuar(filas, resp) {
  const tabla = [];
  for (const f of filas) {
    let mejor = null;
    for (const ronda of RONDAS) {
      const r = resp[ronda.id], dichas = f[ronda.id];
      if (!r || !dichas || !Object.keys(dichas).length) { continue; }
      let aciertos = 0, total = 0;
      for (const [id, , tipo] of preguntasDe(ronda)) {
        if (!(id in r)) { continue; }
        total++;
        if (dichas[id] !== undefined && acierta(id, tipo, dichas[id], r[id], ronda.id)) { aciertos++; }
      }
      const esta = { ronda: ronda.id, aciertos: aciertos, total: total };
      if (total && (!mejor || comparar(esta, mejor) < 0)) { mejor = esta; }
    }
    if (mejor) { tabla.push(Object.assign({ usuario: f.usuario, pct: Math.round(mejor.aciertos * 100 / mejor.total) }, mejor)); }
  }
  tabla.sort((a, b) => comparar(a, b) || (a.usuario < b.usuario ? -1 : 1));
  tabla.forEach((x, i) => { x.puesto = i && comparar(x, tabla[i - 1]) === 0 ? tabla[i - 1].puesto : i + 1; });
  return tabla;
}
async function participantes(env) {
  const filas = [];
  let cursor;
  do {
    const pagina = await env.CHECKINS.list({ prefix: "pk:", cursor: cursor });
    for (const k of pagina.keys) {
      // Las respuestas viajan en la metadata de la clave: así no hace falta leer una por una
      const r = k.metadata && k.metadata.r1 ? k.metadata : await env.CHECKINS.get(k.name, "json");
      if (r) { filas.push(Object.assign({ usuario: k.name.slice(3) }, r)); }
    }
    cursor = pagina.list_complete ? undefined : pagina.cursor;
  } while (cursor);
  return filas;
}

async function armarTabla(env, d, ahora, h) {
  const resp = respuestas(d, ahora);
  if (!Object.keys(resp).length) { return null; }
  // Las respuestas de la gente ya están cerradas cuando algo se resuelve: la tabla se rehace
  // solo si cambian las respuestas correctas (así no se gasta la cuota del KV en cada vuelta)
  const firma = JSON.stringify(resp);
  const previa = await env.CHECKINS.get("pkd:tabla", "json");
  if (previa && previa.firma === firma) { return previa; }
  const filas = await participantes(env);
  const textos = {};
  for (const [ronda, r] of Object.entries(resp)) {
    textos[ronda] = {};
    for (const [k, v] of Object.entries(r)) { textos[ronda][k] = v && typeof v === "object" ? v.texto : v; }
  }
  const tabla = {
    etapa: resp.final ? "final" : "parcial",
    respuestas: textos,
    anuladas: resp.final ? A_MANO.filter((q) => !(q in resp.final)) : [],
    participantes: filas.length,
    // Los primeros 50 y, si hay muchos empatados en los puestos con premio, todos ellos
    tabla: puntuar(filas, resp).filter((x, i) => i < 50 || x.puesto <= 3),
    firma: firma
  };
  await h.kvPut(env, "pkd:tabla", JSON.stringify(tabla));
  return tabla;
}

export async function pickemVuelta(env, h) {
  if (!env.CHECKINS) { return; }
  const ahora = Date.now();
  if (ahora < INICIO) { return; }
  const d = await leerDatos(env);
  const antes = JSON.stringify(d);
  if (!env.RIOT_API_KEY) { d.error = "falta el secreto RIOT_API_KEY"; }
  else if (!d.cubierto.final || d.pendientes || ahora <= FIN + 2 * 3600000) {   // con todo leído no se pregunta más a Riot
    d.error = null;
    try { await actualizarDatos(env, d, ahora); }
    catch (e) { d.error = String(e && e.message || "error"); }
  }
  for (const { id } of RONDAS) {
    if (!d.resueltas[id] && !d.error && ahora >= TRAMOS[id].hasta + FIJA && lista(d, id, ahora)) { d.resueltas[id] = calcular(d, id); }
  }
  if (JSON.stringify(d) !== antes) { await h.kvPut(env, "pkd:datos", JSON.stringify(d)); }
  await armarTabla(env, d, ahora, h);
}

// Prueba de la clave antes del torneo. Si la cuenta del torneo no aparece (404), se mira una que
// ya existe: así se distingue "la clave no anda" de "la cuenta del torneo todavía no está".
export async function probarRiot(env) {
  const cuenta = env.PICKEM_RIOT_ID || CUENTA;
  const falla = (e) => "falla: " + String(e && e.message || "error");
  try { await mirarCuenta(env, cuenta); return { riot: "ok", cuentaTorneo: "ok", cuenta: cuenta }; }
  catch (e) { if (e.status !== 404) { return { riot: falla(e), cuentaTorneo: "sin comprobar", cuenta: cuenta }; } }
  try { await mirarCuenta(env, CONOCIDA); return { riot: "ok", cuentaTorneo: "no aparece (404)", cuenta: cuenta }; }
  catch (e) { return { riot: falla(e), cuentaTorneo: "no aparece (404)", cuenta: cuenta }; }
}

export async function pickemPrueba(env, h) {
  const ahora = Date.now();
  if (!env.CHECKINS || !env.RIOT_API_KEY || ahora >= INICIO) { return; }
  const r = await probarRiot(env);
  const dia = new Date(ahora - 3 * 3600000).toISOString().slice(0, 10);   // fecha de Argentina
  const previa = await env.CHECKINS.get("pkd:prueba", "json");
  if (previa && previa.dia === dia && previa.riot === r.riot && previa.cuentaTorneo === r.cuentaTorneo && previa.cuenta === r.cuenta) { return; }
  await h.kvPut(env, "pkd:prueba", JSON.stringify(Object.assign(r, { dia: dia, cuando: new Date(ahora).toISOString() })));
}

export async function pickemEstado(env) {
  const prueba = env.CHECKINS ? await env.CHECKINS.get("pkd:prueba", "json") : null;
  const d = env.CHECKINS ? await env.CHECKINS.get("pkd:datos", "json") : null;
  return new Response(JSON.stringify({
    clave: !!env.RIOT_API_KEY,
    prueba: prueba,
    torneo: d ? { error: d.error || null, partidas: Object.keys(d.partidas || {}).length } : null
  }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

// «Cómo voy» de la portada: sale de lo que ya leyó la vuelta del cron (no consulta a Riot por visita).
// Hasta que el torneo arranque y se encuentre la cuenta, responde vacío y la página muestra rayitas.
export async function pickemCuenta(env) {
  const d = env.CHECKINS ? await env.CHECKINS.get("pkd:datos", "json") : null;
  let out = {};
  if (d && d.cuenta) {
    const i = d.cuenta.lastIndexOf("#"), p = jugadas(Object.assign({ partidas: {} }, d), INICIO, FIN);
    const ganadas = p.filter((x) => x.gano).length;
    out = {
      name: d.cuenta.slice(0, i), tag: d.cuenta.slice(i + 1),
      tier: d.rango ? d.rango.tier : null, rank: d.rango ? d.rango.div : null, lp: d.rango ? d.rango.lp : null,
      wins: ganadas, losses: p.length - ganadas
    };
  }
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" } });
}

export async function pickemTabla(env) {
  const t = env.CHECKINS ? await env.CHECKINS.get("pkd:tabla") : null;
  return new Response(t || "{}", { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" } });
}

export async function pickemDatos(url, env, h) {
  if (!env.CHECKINS || !env.ADMIN_KEY) { return h.plain("Falta configurar", 500); }
  if (!h.same(url.searchParams.get("key"), env.ADMIN_KEY)) { return h.plain("No autorizado", 401); }
  const d = await leerDatos(env);
  let cambio = false;
  const q18 = url.searchParams.get("q18"), q19 = url.searchParams.get("q19");
  if (q18 && /^\d{1,4}$/.test(q18)) { d.manual.q18 = q18; cambio = true; }
  if (q19 === "s" || q19 === "n") { d.manual.q19 = q19; cambio = true; }
  if (cambio) { await h.kvPut(env, "pkd:mano", JSON.stringify(d.manual)); await armarTabla(env, d, Date.now(), h); }
  // &probar=1: comprueba ahora mismo la clave de Riot y que la cuenta exista (sirve antes del torneo)
  let prueba;
  if (url.searchParams.get("probar") === "1") {
    if (!env.RIOT_API_KEY) { prueba = "falta el secreto RIOT_API_KEY"; }
    else {
      const cuenta = env.PICKEM_RIOT_ID || CUENTA;
      try {
        await mirarCuenta(env, cuenta);
        prueba = "ok: la clave anda y encontró la cuenta " + cuenta;
      } catch (e) { prueba = "falla con " + cuenta + ": " + (e && e.message); }
    }
  }
  const p = jugadas(d, INICIO, FIN);
  return new Response(JSON.stringify({
    prueba: prueba, cuenta: d.cuenta || null, error: d.error, partidas: p.length, victorias: p.filter((x) => x.gano).length,
    pendientes: d.pendientes || 0, rango: d.rango, rangoMasAlto: d.maximo, fotos: d.fotos,
    aMano: d.manual, respuestas: respuestas(d, Date.now())
  }, null, 2), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
