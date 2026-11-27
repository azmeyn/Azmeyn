/* ------------------------------ Pick'em del SoloBoom 6 ------------------------------
   La página /pickem arma un código con las respuestas; la persona lo pega en el chat de Twitch
   (!pickem CODIGO) y recién ahí se guarda, a su nombre. La página no escribe nada en el servidor,
   así nadie puede llenar la base desde afuera.

     /api/pickem?key=PRESENTE_KEY&user=...&c=...   lo llama el comando !pickem de StreamElements
     /api/pickem-lista?key=ADMIN_KEY               todas las respuestas (la abre Maxi)

   Hay cuatro rondas: una por semana (10 preguntas: 4 se repiten y 6 cambian) y la del torneo (15). Gana la mejor
   ronda de cada persona. El código es "p3." + 10 de la semana 1 + 10 de la semana 2 + 10 de la
   semana 3 + 15 del torneo, separadas por puntos. Una respuesta vacía es una pregunta sin contestar. */

export const ABRE = Date.parse("2026-11-29T03:00:00Z");        // 29/11 00:00 ARG

// Tipo de cada pregunta: num (entero), dec (un decimal), sn (s / n), camp (campeón), rango (0 a 11)
export const TIPOS = {
  // se repiten las tres semanas
  q02: "num", q03: "num", q04: "sn", q09: "rango",
  // semana 1
  q05: "camp", q06: "num", q07: "sn", q08: "num", q11: "num", q12: "num",
  // semana 2
  q33: "sn", q34: "sn", q35: "camp", q36: "num", q37: "num", q38: "num",
  // semana 3 (en q39: s = gano, n = pierdo)
  q39: "sn", q40: "num", q41: "sn", q42: "sn", q43: "num", q44: "num",
  // torneo
  q13: "rango", q14: "num", q15: "rango", q16: "num", q17: "num", q18: "num", q19: "sn", q20: "num",
  q21: "num", q22: "camp", q23: "camp", q24: "num", q25: "num", q27: "dec", q28: "num"
};

// Hasta cuándo se puede mandar cada ronda (18:00 ARG). La semana 1 cierra el miércoles 2/12 para dar
// tiempo a votar; las otras, el lunes; la del torneo cierra con la semana 3.
// El orden de "preguntas" es el orden en el código y en la página.
export const RONDAS = [
  { id: "r1", bloque: "semana", nombre: "semana 1", cierra: Date.parse("2026-12-02T21:00:00Z"),
    preguntas: ["q02", "q03", "q04", "q05", "q06", "q07", "q08", "q09", "q11", "q12"] },
  { id: "r2", bloque: "semana", nombre: "semana 2", cierra: Date.parse("2026-12-07T21:00:00Z"),
    preguntas: ["q02", "q03", "q04", "q33", "q34", "q35", "q36", "q37", "q38", "q09"] },
  { id: "r3", bloque: "semana", nombre: "semana 3", cierra: Date.parse("2026-12-14T21:00:00Z"),
    preguntas: ["q02", "q03", "q04", "q39", "q40", "q41", "q42", "q43", "q44", "q09"] },
  { id: "final", bloque: "final", nombre: "torneo", cierra: Date.parse("2026-12-14T21:00:00Z"),
    preguntas: ["q13", "q14", "q15", "q16", "q17", "q18", "q19", "q20", "q21", "q22", "q23", "q24", "q25", "q27", "q28"] }
];
export const CIERRA_TODO = Math.max(...RONDAS.map((r) => r.cierra));

// [id, bloque, tipo] de las preguntas de una ronda, en orden
export const preguntasDe = (ronda) => ronda.preguntas.map((id) => [id, ronda.bloque, TIPOS[id]]);
const CAMPOS = RONDAS.reduce((n, r) => n + r.preguntas.length, 0);
function valido(tipo, v) {
  if (tipo === "num") { return /^\d{1,4}$/.test(v); }
  if (tipo === "dec") { return /^\d{1,2}(_\d)?$/.test(v); }     // 3_4 = 3,4
  if (tipo === "sn") { return v === "s" || v === "n"; }
  if (tipo === "camp") { return /^[a-z]{2,16}$/.test(v); }
  if (tipo === "rango") { return /^(\d|1[01])$/.test(v); }  // posición en la lista RANGOS de la página (12)
  return false;
}

const vacias = () => Object.fromEntries(RONDAS.map((r) => [r.id, {}]));

// Devuelve { r1: {...}, r2: {...}, r3: {...}, final: {...} } o null si el código no sirve
export function leerCodigo(codigo) {
  const partes = String(codigo || "").trim().toLowerCase().split(".");
  if (partes[0] !== "p3" || partes.length !== CAMPOS + 1) { return null; }
  const out = vacias();
  let i = 1;
  for (const ronda of RONDAS) {
    for (const [id, , tipo] of preguntasDe(ronda)) {
      const v = partes[i++];
      if (v === "") { continue; }
      if (!valido(tipo, v)) { return null; }
      out[ronda.id][id] = v;
    }
  }
  return out;
}

const cuantas = (o) => Object.keys(o || {}).length;

export async function pickem(url, env, h) {
  if (!env.CHECKINS || !env.PRESENTE_KEY) { return h.plain("El pick'em todavía no está configurado"); }
  // El comando manda "-" cuando no escriben nada después de !pickem (StreamElements no contesta si va vacío)
  const codigo = (url.searchParams.get("c") || "").trim().replace(/^-$/, "");
  // Sin código no se guarda nada: el enlace se contesta sin pedir la clave
  if (!codigo) { return h.plain("Pick'em del SoloBoom: completalo en azmeyn.com/pickem y pegá acá lo que te da"); }
  if (!h.same(url.searchParams.get("key"), env.PRESENTE_KEY)) { return h.plain("No autorizado", 401); }
  const user = h.cleanUser(url.searchParams.get("user"));
  if (!user) { return h.plain("No pude leer tu usuario, probá de nuevo"); }

  const ahora = Date.now();
  if (ahora < ABRE) { return h.plain("@" + user + " el pick'em abre el 29/11"); }
  if (ahora >= CIERRA_TODO) { return h.plain("@" + user + " el pick'em ya cerró"); }
  const nuevo = leerCodigo(codigo);
  if (!nuevo) { return h.plain("@" + user + " ese código no sirve. Copialo entero desde azmeyn.com/pickem"); }

  const clave = "pk:" + user;
  const guardado = Object.assign(vacias(), (await env.CHECKINS.get(clave, "json")) || {});
  const abiertas = RONDAS.filter((r) => ahora < r.cierra);
  // ¿Manda algo distinto de una ronda que ya cerró?
  const tarde = RONDAS.some((r) => ahora >= r.cierra &&
    Object.entries(nuevo[r.id]).some(([k, v]) => guardado[r.id][k] !== v));
  if (!abiertas.some((r) => cuantas(nuevo[r.id]))) {
    return h.plain("@" + user + (tarde ? " esa ronda ya cerró. Completá las que siguen en azmeyn.com/pickem" : " no contestaste ninguna pregunta"));
  }
  // Una respuesta nueva reemplaza a la anterior; lo que venga vacío no borra lo guardado
  const foto = () => JSON.stringify(RONDAS.map((r) => guardado[r.id]));
  const antes = foto();
  for (const r of abiertas) { guardado[r.id] = Object.assign({}, guardado[r.id], nuevo[r.id]); }
  // Si no cambió nada no se escribe: repetir el mismo código no gasta la cuota del KV
  if (foto() !== antes) {
    guardado.cuando = new Date(ahora).toISOString();
    // Las respuestas viajan también en la metadata (tope de Cloudflare: 1024) para armar la tabla barato
    const meta = Object.fromEntries(RONDAS.map((r) => [r.id, guardado[r.id]]));
    await h.kvPut(env, clave, JSON.stringify(guardado), JSON.stringify(meta).length <= 1000 ? { metadata: meta } : {});
  }

  const resumen = RONDAS.map((r) => r.nombre + " " + cuantas(guardado[r.id]) + "/" + preguntasDe(r).length).join(", ");
  return h.plain("@" + user + " pick'em guardado: " + resumen + (tarde ? " (lo que ya había cerrado no cambió)" : ""));
}

export async function pickemLista(url, env, h) {
  if (!env.CHECKINS || !env.ADMIN_KEY) { return h.plain("Falta configurar", 500); }
  if (!h.same(url.searchParams.get("key"), env.ADMIN_KEY)) { return h.plain("No autorizado", 401); }
  const filas = [];
  let cursor;
  do {
    const pagina = await env.CHECKINS.list({ prefix: "pk:", cursor: cursor });
    for (const k of pagina.keys) {
      const r = await env.CHECKINS.get(k.name, "json");
      if (r) { filas.push(Object.assign({ usuario: k.name.slice(3) }, r)); }
    }
    cursor = pagina.list_complete ? undefined : pagina.cursor;
  } while (cursor);
  return new Response(JSON.stringify({ participantes: filas.length, filas: filas }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
