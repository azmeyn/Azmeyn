/* ------------------------------ Pick'em del SoloBoom 6 ------------------------------
   La página /pickem arma un código con las respuestas; la persona lo pega en el chat de Twitch
   (!pickem CODIGO) y recién ahí se guarda, a su nombre. La página no escribe nada en el servidor,
   así nadie puede llenar la base desde afuera.

     /api/pickem?key=PRESENTE_KEY&user=...&c=...   lo llama el comando !pickem de StreamElements
     /api/pickem-lista?key=ADMIN_KEY               todas las respuestas (la abre Maxi)

   El código es "p1." + las 25 respuestas separadas por puntos, en el orden de PREGUNTAS.
   Una respuesta vacía es una pregunta sin contestar. */

export const ABRE = Date.parse("2026-11-29T03:00:00Z");        // 29/11 00:00 ARG
export const CIERRA_SEMANA = Date.parse("2026-11-30T21:00:00Z"); // 30/11 18:00 ARG
export const CIERRA_FINAL = Date.parse("2026-12-14T03:00:00Z");  // fin del 13/12 ARG

// [id, bloque, tipo]. Tipos: num (entero), dec (un decimal), sn (s / n), camp (campeón), rango (0 a 11)
export const PREGUNTAS = [
  ["q02", "semana", "num"], ["q03", "semana", "num"], ["q04", "semana", "sn"], ["q05", "semana", "camp"],
  ["q06", "semana", "num"], ["q07", "semana", "sn"], ["q08", "semana", "num"], ["q09", "semana", "rango"],
  ["q11", "semana", "num"], ["q12", "semana", "num"],
  ["q13", "final", "rango"], ["q14", "final", "num"], ["q15", "final", "rango"], ["q16", "final", "num"],
  ["q17", "final", "num"], ["q18", "final", "num"], ["q19", "final", "sn"], ["q20", "final", "num"],
  ["q21", "final", "num"], ["q22", "final", "camp"], ["q23", "final", "camp"], ["q24", "final", "num"],
  ["q25", "final", "num"], ["q27", "final", "dec"], ["q28", "final", "num"]
];

function valido(tipo, v) {
  if (tipo === "num") { return /^\d{1,4}$/.test(v); }
  if (tipo === "dec") { return /^\d{1,2}(_\d)?$/.test(v); }     // 3_4 = 3,4
  if (tipo === "sn") { return v === "s" || v === "n"; }
  if (tipo === "camp") { return /^[a-z]{2,16}$/.test(v); }
  if (tipo === "rango") { return /^(\d|1[01])$/.test(v); }  // posición en la lista RANGOS de la página (12)
  return false;
}

// Devuelve { semana: {...}, final: {...} } o null si el código no sirve
export function leerCodigo(codigo) {
  const partes = String(codigo || "").trim().toLowerCase().split(".");
  if (partes[0] !== "p1" || partes.length !== PREGUNTAS.length + 1) { return null; }
  const out = { semana: {}, final: {} };
  for (let i = 0; i < PREGUNTAS.length; i++) {
    const [id, bloque, tipo] = PREGUNTAS[i];
    const v = partes[i + 1];
    if (v === "") { continue; }
    if (!valido(tipo, v)) { return null; }
    out[bloque][id] = v;
  }
  return out;
}

export async function pickem(url, env, h) {
  if (!env.CHECKINS || !env.PRESENTE_KEY) { return h.plain("El pick'em todavía no está configurado"); }
  const codigo = (url.searchParams.get("c") || "").trim();
  // Sin código no se guarda nada: el enlace se contesta sin pedir la clave
  if (!codigo) { return h.plain("Pick'em del SoloBoom: completalo en azmeyn.com/pickem y pegá acá lo que te da"); }
  if (!h.same(url.searchParams.get("key"), env.PRESENTE_KEY)) { return h.plain("No autorizado", 401); }
  const user = h.cleanUser(url.searchParams.get("user"));
  if (!user) { return h.plain("No pude leer tu usuario, probá de nuevo"); }

  const ahora = Date.now();
  if (ahora < ABRE) { return h.plain("@" + user + " el pick'em abre el 29/11"); }
  if (ahora >= CIERRA_FINAL) { return h.plain("@" + user + " el pick'em ya cerró"); }
  const nuevo = leerCodigo(codigo);
  if (!nuevo) { return h.plain("@" + user + " ese código no sirve. Copialo entero desde azmeyn.com/pickem"); }

  const clave = "pk:" + user;
  const guardado = (await env.CHECKINS.get(clave, "json")) || { semana: {}, final: {} };
  const semanaAbierta = ahora < CIERRA_SEMANA;
  const nSemana = Object.keys(nuevo.semana).length, nFinal = Object.keys(nuevo.final).length;
  if (!nFinal && (!semanaAbierta || !nSemana)) {
    return h.plain("@" + user + (semanaAbierta ? " no contestaste ninguna pregunta" : " las de la primera semana ya cerraron y no mandaste finales"));
  }
  // Una respuesta nueva reemplaza a la anterior; lo que venga vacío no borra lo guardado
  const antes = JSON.stringify([guardado.semana, guardado.final]);
  if (semanaAbierta) { guardado.semana = Object.assign({}, guardado.semana, nuevo.semana); }
  guardado.final = Object.assign({}, guardado.final, nuevo.final);
  // Si no cambió nada no se escribe: repetir el mismo código no gasta la cuota del KV
  if (JSON.stringify([guardado.semana, guardado.final]) !== antes) {
    guardado.cuando = new Date(ahora).toISOString();
    await h.kvPut(env, clave, JSON.stringify(guardado), { metadata: { semana: guardado.semana, final: guardado.final } });
  }

  const s = Object.keys(guardado.semana).length, f = Object.keys(guardado.final).length;
  return h.plain("@" + user + " pick'em guardado: " + s + " de 10 de la primera semana y " + f + " de 15 finales" +
    (!semanaAbierta && nSemana ? " (las de la semana ya habían cerrado)" : ""));
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
