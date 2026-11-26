/* ------------------------- Pick'em: se resuelve solo -------------------------
   Corre con el cron (cada 5 minutos, solo durante el torneo):
     1) lee las partidas SoloQ de la cuenta del torneo y el rango (API de Riot),
     2) anota el rango más alto y la foto del rango al cerrar la primera semana y el torneo,
     3) calcula las respuestas y la tabla, y la guarda para la web.
   Necesita el secreto RIOT_API_KEY. Sin él no hace nada y lo deja anotado.

     /api/pickem-tabla                    pública: tabla y respuestas ya resueltas
     /api/pickem-estado                   pública: si hay clave de Riot y qué dio la última prueba
     /api/pickem-datos?key=ADMIN_KEY      lo que leyó de Riot. Con &q18=12&q19=s se cargan a mano
                                          las dos que dependen de la tabla oficial del torneo.

   Antes del torneo el mismo cron prueba la clave con la cuenta del torneo y anota el resultado
   (se escribe solo si cambia, y una vez por día). */
import { PREGUNTAS } from "./pickem.js";

export const INICIO = Date.parse("2026-11-30T21:00:00Z");       // 30/11 18:00 ARG
export const FIN_SEMANA = Date.parse("2026-12-07T03:00:00Z");   // termina el domingo 6/12 ARG
export const FIN = Date.parse("2026-12-20T21:00:00Z");          // 20/12 18:00 ARG
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

const vacio = () => ({ puuid: null, partidas: {}, rango: null, maximo: null, semana: null, final: null, manual: {}, error: null });

export async function leerDatos(env) {
  return Object.assign(vacio(), (await env.CHECKINS.get("pkd:datos", "json")) || {});
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
  // Fotos del rango al cerrar la primera semana y el torneo. Se sacan apenas pasa el corte; si la
  // vuelta llega tarde (y ya pudo haber jugado de nuevo), vale lo último visto antes del corte.
  for (const [campo, corte] of [["semana", FIN_SEMANA], ["final", FIN]]) {
    if (ahora < corte) { d["antes_" + campo] = d.rango; }
    else if (!d[campo]) {
      const aTiempo = ahora - corte <= MARGEN * 2 || d["antes_" + campo] === undefined;
      d[campo] = { rango: aTiempo ? d.rango : d["antes_" + campo], cuando: new Date(ahora).toISOString() };
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
      k: yo.kills || 0, m: yo.deaths || 0, a: yo.assists || 0, penta: yo.pentaKills || 0
    };
  }
  d.pendientes = Math.max(0, faltan.length - NUEVAS_POR_VUELTA);
}

// Partidas que cuentan en un tramo, en orden (sin remakes)
export function jugadas(d, hasta) {
  return Object.values(d.partidas).filter((p) => !p.remake && p.ini >= INICIO && p.fin <= hasta).sort((a, b) => a.ini - b.ini);
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

// Devuelve { q02: respuesta, ... } solo con lo que ya se puede resolver
export function respuestas(d, ahora) {
  const r = {};
  const siNo = (b) => (b ? "s" : "n");
  if (ahora >= FIN_SEMANA && d.semana && !d.pendientes) {
    const p = jugadas(d, FIN_SEMANA), g = p.filter((x) => x.gano).length, c = porCampeon(p);
    r.q02 = g; r.q03 = p.length; r.q04 = siNo(g > p.length - g);
    r.q05 = mejores(c, (x) => x.j); r.q06 = c.size; r.q07 = siNo(p.some((x) => x.penta > 0)); r.q08 = racha(p, true);
    r.q09 = indiceRango(d.semana.rango);
    r.q11 = p.length ? Math.max(...p.map((x) => x.k)) : null; r.q12 = p.length ? Math.max(...p.map((x) => x.m)) : null;
  }
  if (ahora >= FIN && d.final && !d.pendientes) {
    const p = jugadas(d, FIN), g = p.filter((x) => x.gano).length, c = porCampeon(p);
    const suma = (k) => p.reduce((a, x) => a + x[k], 0);
    r.q13 = indiceRango(d.final.rango); r.q14 = d.final.rango ? d.final.rango.lp : null; r.q15 = indiceRango(d.maximo);
    r.q16 = p.length ? Math.round(g * 100 / p.length) : null; r.q17 = p.length;
    r.q20 = racha(p, true); r.q21 = racha(p, false);
    r.q22 = mejores(c, (x) => x.j); r.q23 = mejores(c, (x) => x.g / x.j, (x) => x.j >= 5);
    r.q24 = c.size; r.q25 = suma("penta");
    r.q27 = p.length ? Math.round((suma("k") + suma("a")) * 10 / Math.max(1, suma("m"))) / 10 : null;
    r.q28 = p.length ? Math.floor(Math.max(...p.map((x) => x.dur)) / 60) : null;
    for (const q of A_MANO) { if (d.manual[q] !== undefined) { r[q] = q === "q18" ? Number(d.manual[q]) : d.manual[q]; } }
  }
  for (const k of Object.keys(r)) { if (r[k] === null || r[k] === undefined) { delete r[k]; } }
  return r;
}

// En las de número suma el punto quien queda más cerca (si empatan, todos). En el resto, hay que acertar.
export function puntuar(filas, resp) {
  const tabla = filas.map((f) => ({ usuario: f.usuario, puntos: 0 }));
  for (const [id, bloque, tipo] of PREGUNTAS) {
    if (!(id in resp)) { continue; }
    const correcta = resp[id];
    const dichas = filas.map((f) => (f[bloque] || {})[id]);
    if (tipo === "num" || tipo === "dec") {
      const dist = dichas.map((v) => v === undefined ? Infinity : Math.abs(Math.round((Number(String(v).replace("_", ".")) - correcta) * 10)));
      const menor = Math.min(...dist);
      if (menor !== Infinity) { dist.forEach((x, i) => { if (x === menor) { tabla[i].puntos++; } }); }
    } else {
      dichas.forEach((v, i) => {
        if (v === undefined) { return; }
        const ok = tipo === "camp" ? correcta.claves.includes(v) : String(v) === String(correcta);
        if (ok) { tabla[i].puntos++; }
      });
    }
  }
  return tabla.sort((a, b) => b.puntos - a.puntos || (a.usuario < b.usuario ? -1 : 1));
}

async function participantes(env) {
  const filas = [];
  let cursor;
  do {
    const pagina = await env.CHECKINS.list({ prefix: "pk:", cursor: cursor });
    for (const k of pagina.keys) {
      // Las respuestas viajan en la metadata de la clave: así no hace falta leer una por una
      const r = k.metadata && k.metadata.semana ? k.metadata : await env.CHECKINS.get(k.name, "json");
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
  for (const [k, v] of Object.entries(resp)) { textos[k] = v && typeof v === "object" ? v.texto : v; }
  const tabla = {
    etapa: ahora >= FIN && d.final ? "final" : "semana",
    respuestas: textos,
    anuladas: ahora >= FIN && d.final ? A_MANO.filter((q) => !(q in resp)) : [],
    participantes: filas.length,
    tabla: puntuar(filas, resp).slice(0, 50),
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
  else if (!d.final || d.pendientes) {       // con todo leído y la foto final no se pregunta más a Riot
    d.error = null;
    try { await actualizarDatos(env, d, ahora); }
    catch (e) { d.error = String(e && e.message || "error"); }
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
  if (cambio) { await h.kvPut(env, "pkd:datos", JSON.stringify(d)); await armarTabla(env, d, Date.now(), h); }
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
  const p = jugadas(d, FIN);
  return new Response(JSON.stringify({
    prueba: prueba, cuenta: d.cuenta || null, error: d.error, partidas: p.length, victorias: p.filter((x) => x.gano).length,
    pendientes: d.pendientes || 0, rango: d.rango, rangoMasAlto: d.maximo, semana: d.semana, final: d.final,
    aMano: d.manual, respuestas: respuestas(d, Date.now())
  }, null, 2), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
