// Tabla pública de tickets (pedido de Maxi, 28/11): cuántos tiene cada uno, por semana y en total.
// El cron la arma cada 5 minutos a partir de lo que ya guarda cada "u:<usuario>" y la escribe solo
// si cambió (así no gasta la cuota del KV). La web solo lee esa copia: no lista usuarios por visita.
const CLAVE = "tk:tabla";
const total = (f) => f[1] + f[2] + f[3];

export async function armarTablaTickets(env, h) {
  if (!env.CHECKINS) { return null; }
  const filas = [];
  let cursor;
  do {
    const pagina = await env.CHECKINS.list({ prefix: "u:", cursor: cursor });
    for (const k of pagina.keys) {
      // Los tickets viajan en la metadata de la clave: no hace falta leer una por una
      const w = (k.metadata && k.metadata.w) || {};
      const f = [k.name.slice(2)].concat([1, 2, 3].map((n) => Math.max(0, Math.floor(Number(w[n]) || 0))));
      if (total(f)) { filas.push(f); }
    }
    cursor = pagina.list_complete ? undefined : pagina.cursor;
  } while (cursor);
  filas.sort((a, b) => total(b) - total(a) || (a[0] < b[0] ? -1 : 1));
  const previa = await env.CHECKINS.get(CLAVE, "json");
  if (previa && JSON.stringify(previa.filas) === JSON.stringify(filas)) { return previa; }
  const nueva = { filas: filas, cuando: new Date().toISOString() };
  await h.kvPut(env, CLAVE, JSON.stringify(nueva));
  return nueva;
}

export async function tablaTickets(env) {
  const t = env.CHECKINS ? await env.CHECKINS.get(CLAVE) : null;
  return new Response(t || '{"filas":[]}', {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" }
  });
}
