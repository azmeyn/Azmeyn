/* ------------------------------ Pick'em del SoloBoom 6 ------------------------------
   La página /pickem arma un código con las respuestas; la persona lo pega en el chat de Twitch
   (!pickem CODIGO) y recién ahí se guarda, a su nombre. La página no escribe nada en el servidor,
   así nadie puede llenar la base desde afuera.

     /api/pickem?key=PRESENTE_KEY&user=...&c=...   lo llama el comando !pickem de StreamElements
     /api/pickem-lista?key=ADMIN_KEY               todas las respuestas (la abre Maxi)

   Hay cuatro rondas: una por semana (9 preguntas: 3 se repiten y 6 cambian) y la del torneo (14).
   Gana la mejor ronda de cada persona. El código es "p4." + las preguntas de cada ronda en orden,
   separadas por puntos. Una respuesta vacía es una pregunta sin contestar. */

export const ABRE = Date.parse("2026-11-29T03:00:00Z");        // 29/11 00:00 ARG

// Tipo de cada pregunta: num (escribir un entero), rg (elegir uno de tres tramos: 1, 2 o 3),
// sn (s / n), camp (campeón), rango (0 a 11)
export const TIPOS = {
  // se repiten las tres semanas
  q02: "num", q03: "rg", q09: "rango",
  // semana 1
  q05: "camp", q06: "rg", q07: "sn", q08: "rg", q11: "num", q12: "rg",
  // semana 2
  q33: "sn", q34: "sn", q35: "camp", q36: "num", q37: "rg", q38: "rg",
  // semana 3 (en q39: s = gano, n = pierdo)
  q39: "sn", q40: "rg", q41: "sn", q42: "sn", q43: "num", q44: "rg",
  // torneo
  q13: "rango", q14: "num", q15: "rango", q16: "rg", q17: "rg", q18: "num", q19: "sn", q20: "rg",
  q21: "rg", q22: "camp", q24: "rg", q25: "rg", q27: "rg", q28: "rg"
};

// Tramos de las preguntas "rg": [a, b] es 1 = menos de a, 2 = de a a b, 3 = más de b.
// Las que cambian según la semana van por ronda (la semana 1 es más corta).
export const CORTES = {
  q03: { r1: [20, 30], r2: [30, 45], r3: [30, 45] },
  q06: [4, 7], q08: [4, 6], q12: [8, 11], q37: [5, 8], q38: [12, 20], q40: [3, 5], q44: [35, 42],
  q16: [50, 59], q17: [90, 130], q20: [5, 8], q21: [4, 6], q24: [8, 14], q25: [1, 2], q27: [2.5, 3.4], q28: [40, 46]
};
export function tramoDe(id, ronda, valor) {
  const [a, b] = Array.isArray(CORTES[id]) ? CORTES[id] : CORTES[id][ronda];
  return valor < a ? "1" : valor <= b ? "2" : "3";
}

// Hasta cuándo se puede mandar cada ronda (18:00 ARG). La semana 1 cierra el miércoles 2/12 para dar
// tiempo a votar; las otras, el lunes; la del torneo cierra con la semana 3.
// El orden de "preguntas" es el orden en el código y en la página.
export const RONDAS = [
  { id: "r1", bloque: "semana", nombre: "semana 1", cierra: Date.parse("2026-12-02T21:00:00Z"),
    preguntas: ["q05", "q02", "q03", "q07", "q06", "q08", "q11", "q12", "q09"] },
  { id: "r2", bloque: "semana", nombre: "semana 2", cierra: Date.parse("2026-12-07T21:00:00Z"),
    preguntas: ["q35", "q02", "q03", "q33", "q34", "q37", "q38", "q36", "q09"] },
  { id: "r3", bloque: "semana", nombre: "semana 3", cierra: Date.parse("2026-12-14T21:00:00Z"),
    preguntas: ["q42", "q02", "q03", "q39", "q41", "q40", "q44", "q43", "q09"] },
  { id: "final", bloque: "final", nombre: "torneo", cierra: Date.parse("2026-12-14T21:00:00Z"),
    preguntas: ["q22", "q13", "q15", "q14", "q19", "q18", "q16", "q17", "q20", "q21", "q24", "q25", "q27", "q28"] }
];
export const CIERRA_TODO = Math.max(...RONDAS.map((r) => r.cierra));

// [id, bloque, tipo] de las preguntas de una ronda, en orden
export const preguntasDe = (ronda) => ronda.preguntas.map((id) => [id, ronda.bloque, TIPOS[id]]);
const CAMPOS = RONDAS.reduce((n, r) => n + r.preguntas.length, 0);
function valido(tipo, v) {
  if (tipo === "num") { return /^\d{1,4}$/.test(v); }
  if (tipo === "rg") { return /^[123]$/.test(v); }
  if (tipo === "sn") { return v === "s" || v === "n"; }
  if (tipo === "camp") { return /^[a-z]{2,16}$/.test(v); }
  if (tipo === "rango") { return /^(\d|1[01])$/.test(v); }  // posición en la lista RANGOS de la página (12)
  return false;
}

const vacias = () => Object.fromEntries(RONDAS.map((r) => [r.id, {}]));

// Devuelve { r1: {...}, r2: {...}, r3: {...}, final: {...} } o null si el código no sirve
export function leerCodigo(codigo) {
  const partes = String(codigo || "").trim().toLowerCase().split(".");
  if (partes[0] !== "p4" || partes.length !== CAMPOS + 1) { return null; }
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
