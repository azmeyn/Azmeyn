/* ------------------------- Tickets automáticos (SoloBoom 6) -------------------------
   Corre solo cada 5 minutos (cron de Cloudflare, ver "triggers" en wrangler.jsonc) y hace dos cosas:

   1) CANJES: lee el Activity feed de StreamElements (con el SE_JWT que ya está cargado) y,
      por cada canje del ítem "ticket" (800 pts), suma 1 ticket en la semana que corresponde.
      Tope: 3 por semana por persona. Si alguien pasa el tope, se le devuelven los 800 puntos
      (si StreamElements falla, la devolución se reintenta en la vuelta siguiente).
      Cada canje se anota en el KV para no contarlo dos veces.

   2) PREDICCIONES: le pide al Worker panel-stream-azmeyn (por un enlace interno entre Workers,
      "service binding", que no se puede usar desde internet) las predicciones de Twitch ya
      resueltas. A cada persona que acertó le suma +200 puntos en StreamElements y, cuando junta
      3 aciertos en el mismo día (hora ARG), 1 ticket (máximo 1 por día).

   3) SUBS: cada domingo a las 12:00 ARG suma +2 tickets de esa semana a cada sub actual de Twitch
      (una vez por semana y por persona).
      Ojo: Twitch solo informa hasta 10 personas por opción (las que más puntos de canal apostaron).

   Ventana: solo cuenta lo que pasó entre el 30/11 18:00 y el 20/12 18:00 (hora ARG). Lo anterior
   (pruebas, canjes de antes del reset) y lo posterior se ignora.

   Rutas para Maxi (con ADMIN_KEY, la escribe él):
     /api/tickets-auto?key=...                 MODO PRUEBA (por defecto): muestra qué haría, SIN sumar nada
     /api/tickets-auto?key=...&ejecutar=1      corre una vuelta de verdad (lo mismo que hace el cron)
     /api/tickets-auto?key=...&ultimo=1        muestra el último informe guardado

   Si falta algo (SE_JWT, el enlace con el panel, el permiso de predicciones), esa parte se saltea
   y queda anotada en el resultado; el resto del sitio y !presente siguen igual. */

const SE_API = "https://api.streamelements.com/kappa/v2";
const ITEM_TICKET = "ticket";      // nombre del ítem en la tienda de StreamElements
const COSTO_TICKET = 800;
const TOPE_CANJE_SEMANA = 3;
const PTS_ACIERTO = 200;
const ACIERTOS_PARA_TICKET = 3;
const VENTANA_HORAS = 48;          // cuánto para atrás mira el Activity feed en cada vuelta
const DIAS_RECUERDO = 70;          // cuánto tiempo se recuerda un canje o predicción ya procesado
const HORA_INICIO_ARG = 18;        // el torneo arranca a las 18:00 ARG del primer día (y cierra igual el último)
const SUBS_TICKETS = 2;            // tickets por semana para cada sub (decisión D3, 25/11)
const HORA_SUBS_ARG = 12;          // se suman el domingo de cada semana a esta hora (antes del sorteo)
const MAX_PAGOS_VUELTA = 30;       // el plan gratis corta a las 50 llamadas externas por vuelta
const LATIDO_HORAS = 6;         // sin novedades, el informe guardado se renueva como mucho cada tanto (ahorra escrituras de KV)

// El KV puede tardar en mostrar lo recién escrito: durante una vuelta se recuerda lo que se
// guardó y se usa esa copia si es más nueva (rec.v) que la que devuelve el KV. Así no se pisa
// un ticket con otro, ni un !presente que haya entrado en el medio.
function conMemoria(h) {
  const fichas = new Map();
  const copia = function (o) { return JSON.parse(JSON.stringify(o)); };
  return Object.assign({}, h, {
    loadRec: async function (env, user) {
      const leida = await h.loadRec(env, user);
      const mia = fichas.get(user);
      return mia && (mia.v || 0) > (leida.v || 0) ? copia(mia) : leida;
    },
    saveRec: async function (env, user, rec) {
      await h.saveRec(env, user, rec);
      fichas.set(user, copia(rec));
    }
  });
}

// true = StreamElements respondió con un error (no sumó nada, se puede reintentar).
// false = no hubo respuesta: no se sabe si sumó.
function contestoQueNo(e) { return /respondió \d/.test(String(e && e.message)); }

// Lo que hay que mirar a mano queda en el informe y en una lista aparte que no se pisa
function aRevisar(informe, texto) {
  informe.revisar.push(texto);
  informe.errores.push("revisar a mano " + texto);
}

function argDayOf(iso) {
  return new Date(Date.parse(iso) - 3 * 3600000).toISOString().slice(0, 10);
}

// Inicio y fin del torneo en milisegundos (18:00 ARG = 21:00 UTC del primer y del último día)
function ventana(h) {
  const inicio = Date.parse(h.EVENT_START + "T03:00:00Z") + HORA_INICIO_ARG * 3600000;
  const fin = inicio + (h.EVENT_DAYS - 1) * 86400000;
  return { inicio: inicio, fin: fin };
}

function anotarItemIgnorado(informe, item) {
  const k = (item || "(vacío)").slice(0, 60);
  const o = informe.canjes.otrosItems;
  if (o[k] || Object.keys(o).length < 20) { o[k] = (o[k] || 0) + 1; }
}

/* ---------------------------------- Canjes ---------------------------------- */
async function leerCanjes(env, desdeMs, hastaMs) {
  const q = new URLSearchParams({
    after: new Date(desdeMs).toISOString(),
    before: new Date(hastaMs).toISOString(),
    limit: "500",
    types: "redemption",
    origin: "feed"
  });
  const r = await fetch(SE_API + "/activities/" + encodeURIComponent(env.SE_CHANNEL_ID) + "?" + q, {
    headers: { Authorization: "Bearer " + env.SE_JWT, Accept: "application/json" }
  });
  if (!r.ok) { throw new Error("StreamElements (activity feed) respondió " + r.status); }
  const j = await r.json();
  const lista = Array.isArray(j) ? j : (j && Array.isArray(j.docs) ? j.docs : []);
  return lista.filter(function (a) { return a && a.type === "redemption" && a.data; });
}

async function procesarCanjes(env, h, prueba, informe) {
  const ahora = Date.now();
  const v = ventana(h);
  if (ahora < v.inicio) { informe.canjes.nota = "el torneo todavía no empezó"; return; }
  const desde = Math.max(v.inicio, ahora - VENTANA_HORAS * 3600000);

  const acts = await leerCanjes(env, desde, ahora);
  informe.canjes.vistos = acts.length;
  for (const a of acts) {
    const item = String(a.data.redemption || "").trim().toLowerCase();
    // Los ítems que no son "ticket" se ignoran, pero se anotan en el informe: si el ítem de
    // tickets tuviera otro nombre en StreamElements, se vería acá en vez de fallar en silencio.
    if (item !== ITEM_TICKET) { anotarItemIgnorado(informe, item); continue; }
    const user = h.cleanUser(a.data.username);
    const id = String(a._id || "");
    if (!user || !id) { informe.canjes.raros.push({ id: id, usuario: a.data.username || null }); continue; }
    const anotado = await env.CHECKINS.get("canje:" + id);
    if (anotado && anotado !== "reintentar") { continue; }

    const ts = Date.parse(a.createdAt);
    if (isNaN(ts)) { informe.canjes.raros.push({ id: id, usuario: user }); continue; }
    const idx = h.dayIndex(argDayOf(a.createdAt));
    if (!(ts >= v.inicio && ts <= v.fin) || idx < 0 || idx >= h.EVENT_DAYS) { informe.canjes.fueraDeFecha.push(user); continue; }
    const week = Math.floor(idx / 7) + 1;

    const rec = await h.loadRec(env, user);
    rec.c = Object.assign({ 1: 0, 2: 0, 3: 0 }, rec.c);
    if ((rec.cx || []).indexOf(id) >= 0) {   // ya sumado en una vuelta que se cortó antes de marcarlo
      if (!prueba) { await h.kvPut(env, "canje:" + id, "ok", { expirationTtl: DIAS_RECUERDO * 86400 }); }
      continue;
    }
    if (rec.c[week] >= TOPE_CANJE_SEMANA) {
      if (!prueba) {
        // Se anota ANTES de devolver, así nunca se devuelve dos veces. Si StreamElements contesta
        // que no, queda para reintentar; si no contesta, queda para revisar a mano.
        const marcar = function (valor) {
          return h.kvPut(env, "canje:" + id, valor, { expirationTtl: DIAS_RECUERDO * 86400 });
        };
        await marcar("devolviendo");
        try { await h.sePoints(env, user, COSTO_TICKET); }
        catch (e) {
          if (contestoQueNo(e)) {
            await marcar("reintentar");
            informe.errores.push("no pude devolver 800 pts a " + user + " (se reintenta en la próxima vuelta)");
          } else {
            await marcar("revisar");
            aRevisar(informe, "los 800 pts a devolver a " + user + " (StreamElements no contestó)");
          }
          continue;
        }
        await marcar("devuelto");
      }
      informe.canjes.devueltos.push({ usuario: user, semana: week });
      continue;
    }
    informe.canjes.sumados.push({ usuario: user, semana: week });
    if (!prueba) {
      // El ticket y la anotación del canje se guardan juntos en la ficha (rec.cx) y recién
      // después se marca el canje: si algo falla en el medio, no se pierde ni se duplica.
      rec.c[week] += 1;
      rec.w[week] = (rec.w[week] || 0) + 1;
      rec.cx = (rec.cx || []).concat(id).slice(-12);
      await h.saveRec(env, user, rec);
      await h.kvPut(env, "canje:" + id, "ok", { expirationTtl: DIAS_RECUERDO * 86400 });
    }
  }
}

/* ------------------------------- Predicciones ------------------------------- */
async function procesarPredicciones(env, h, prueba, informe) {
  if (!env.PANEL_STREAM || typeof env.PANEL_STREAM.prediccionesResueltas !== "function") {
    informe.predicciones.nota = "falta el enlace con panel-stream-azmeyn (service binding PANEL_STREAM)";
    return;
  }
  const v = ventana(h);
  const preds = await env.PANEL_STREAM.prediccionesResueltas();
  informe.predicciones.vistas = preds.length;
  const simulados = {}; // solo en modo prueba: aciertos acumulados por persona y día
  let pagos = 0;        // llamadas de pago hechas en esta vuelta
  const hora = function (p) { return Date.parse(p.ended_at || p.created_at) || 0; };
  for (const p of preds.slice().sort(function (a, b) { return hora(a) - hora(b); })) {   // de la más vieja a la más nueva
    const cuando = p.ended_at || p.created_at;
    const ts = Date.parse(cuando);
    if (!(ts >= v.inicio && ts <= v.fin)) { continue; }
    const day = argDayOf(cuando);
    const idx = h.dayIndex(day);
    if (idx < 0 || idx >= h.EVENT_DAYS) { continue; }
    const clave = "pred:" + p.id;
    const estado = Object.assign({ hechos: [], pagando: [], pagados: [], revisar: [], completa: false },
      (await env.CHECKINS.get(clave, "json")) || {});
    if (estado.completa) { continue; }
    const guardar = function () {
      return h.kvPut(env, clave, JSON.stringify(estado), { expirationTtl: DIAS_RECUERDO * 86400 });
    };
    const week = Math.floor(idx / 7) + 1;
    const ganadores = (p.ganadores || []).map(h.cleanUser)
      .filter(function (u, i, todos) { return u && todos.indexOf(u) === i; });   // sin nombres repetidos
    const resumen = { titulo: p.title, dia: day, ganadores: ganadores.length, tope10: !!p.tope10, tickets: [] };
    const pendientes = ganadores.filter(function (u) {
      return estado.pagados.indexOf(u) < 0 && estado.revisar.indexOf(u) < 0 && estado.pagando.indexOf(u) < 0;
    });
    // Si hay mucho atrasado, lo que no entra queda entero para la vuelta siguiente (en orden)
    if (!prueba && pagos > 0 && pagos + pendientes.length > MAX_PAGOS_VUELTA) { break; }

    // Paso 1: contar el acierto (y el ticket, si corresponde). La ficha recuerda qué predicciones
    // ya contó (pd.ids), así un corte a mitad de camino nunca cuenta dos veces.
    const marca = String(p.id).slice(-8);
    for (const user of ganadores) {
      if (estado.hechos.indexOf(user) >= 0) { continue; }
      const rec = await h.loadRec(env, user);
      // Una predicción de un día anterior que aparece tarde no pisa la cuenta del día más nuevo
      if (!prueba && rec.pd && rec.pd.day > day) {
        aRevisar(informe, "el acierto atrasado de " + user + " del " + day + " (ver si le corresponde ticket)");
        estado.hechos.push(user);
        continue;
      }
      const sim = user + "|" + day;
      let pd = prueba && simulados[sim] ? simulados[sim] : (rec.pd && rec.pd.day === day ? rec.pd : { day: day, n: 0, t: false });
      if ((pd.ids || []).indexOf(marca) < 0) {
        pd.n += 1;
        pd.ids = (pd.ids || []).concat(marca).slice(-30);
        let ticket = false;
        if (pd.n >= ACIERTOS_PARA_TICKET && !pd.t) { pd.t = true; ticket = true; }
        if (ticket) { resumen.tickets.push(user); }
        if (prueba) { simulados[sim] = pd; continue; }
        rec.pd = pd;
        if (ticket) { rec.w[week] = (rec.w[week] || 0) + 1; }
        await h.saveRec(env, user, rec);
      }
      estado.hechos.push(user);
    }
    if (prueba) { informe.predicciones.procesadas.push(resumen); continue; }

    // Paso 2: pagar los +200. Antes de pagar se anota a quiénes ("pagando") y después cómo salió:
    // dos escrituras por predicción. Si una vuelta se corta en el medio, no se vuelve a pagar a
    // ciegas: esos nombres quedan en "revisar" para mirarlos a mano.
    if (estado.pagando.length) {
      aRevisar(informe, "los +200 de " + estado.pagando.join(", ") + " (una vuelta se cortó mientras pagaba)");
      estado.revisar = estado.revisar.concat(estado.pagando);
      estado.pagando = [];
    }
    let faltan = false;
    if (pendientes.length) {
      pagos += pendientes.length;
      estado.pagando = pendientes;
      await guardar();
      for (const user of pendientes) {
        try {
          await h.sePoints(env, user, PTS_ACIERTO);
          estado.pagados.push(user);
        } catch (e) {
          if (contestoQueNo(e)) {
            // StreamElements contestó que no: se puede reintentar sin riesgo de pagar dos veces
            faltan = true;
            informe.errores.push("no pude sumar +200 a " + user + " (se reintenta en la próxima vuelta)");
          } else {
            // Sin respuesta no se sabe si sumó o no: mejor revisarlo a mano que pagar doble
            estado.revisar.push(user);
            aRevisar(informe, "los +200 de " + user + " (StreamElements no contestó)");
          }
        }
      }
      estado.pagando = [];
    }
    estado.completa = !faltan;
    await guardar();
    informe.predicciones.procesadas.push(resumen);
  }
}

/* ---------------------------- Subs: +2 tickets por semana ----------------------------
   Cada domingo del torneo a las 12:00 ARG (antes del sorteo del cierre) le suma +2 tickets
   de esa semana a cada sub actual de Twitch. Una sola vez por semana y por persona: queda
   anotado en la ficha (rec.s) y en el KV (subs:N). Si el cron se saltea un domingo, lo
   recupera en la vuelta siguiente. La lista sale de panel-stream-azmeyn (permiso
   channel:read:subscriptions de Twitch). */
async function procesarSubs(env, h, prueba, informe) {
  if (!env.PANEL_STREAM || typeof env.PANEL_STREAM.subsActuales !== "function") {
    informe.subs.nota = "falta subsActuales en panel-stream-azmeyn";
    return;
  }
  const ahora = Date.now();
  const v = ventana(h);
  if (ahora < v.inicio) { informe.subs.nota = "el torneo todavía no empezó"; return; }
  const base = Date.parse(h.EVENT_START + "T03:00:00Z");           // 00:00 ARG del primer día
  let subs = null;
  for (let w = 1; w <= 3; w++) {
    const cuando = base + (7 * w - 1) * 86400000 + HORA_SUBS_ARG * 3600000;   // domingo de la semana w, 12:00 ARG
    if (ahora < cuando) { continue; }
    if (await env.CHECKINS.get("subs:" + w)) { continue; }
    // La lista de cada semana se guarda la primera vez: si la vuelta se corta, el reintento usa la misma.
    let lista = prueba ? null : await env.CHECKINS.get("subs:" + w + ":lista", "json");
    if (!lista) {
      if (!subs) { subs = (await env.PANEL_STREAM.subsActuales()).map(h.cleanUser).filter(Boolean); }
      lista = subs;
      if (!prueba) { await h.kvPut(env, "subs:" + w + ":lista", JSON.stringify(lista), { expirationTtl: DIAS_RECUERDO * 86400 }); }
    }
    informe.subs.semanas.push(w);
    for (const user of lista) {
      const rec = await h.loadRec(env, user);
      rec.s = Object.assign({}, rec.s);
      if (rec.s[w]) { continue; }
      informe.subs.sumados.push({ usuario: user, semana: w });
      if (prueba) { continue; }
      rec.s[w] = true;
      rec.w[w] = (rec.w[w] || 0) + SUBS_TICKETS;
      await h.saveRec(env, user, rec);
    }
    if (!prueba) { await h.kvPut(env, "subs:" + w, "ok", { expirationTtl: DIAS_RECUERDO * 86400 }); }
  }
}

/* Solo en modo prueba: lo que ven StreamElements y Twitch en los últimos 7 días, sin importar
   las fechas del torneo. Sirve para comprobar antes del 30/11 que los datos llegan bien. */
async function muestra(env, informe) {
  informe.muestra = { canjes7dias: null, predicciones: null };
  try {
    const acts = await leerCanjes(env, Date.now() - 7 * 86400000, Date.now());
    informe.muestra.canjes7dias = acts.slice(0, 20).map(function (a) {
      return { item: a.data.redemption || null, usuario: a.data.username || null, fecha: a.createdAt || null };
    });
  } catch (e) { informe.muestra.canjes7dias = "error: " + e.message; }
  if (env.PANEL_STREAM && typeof env.PANEL_STREAM.prediccionesResueltas === "function") {
    try {
      const preds = await env.PANEL_STREAM.prediccionesResueltas();
      informe.muestra.predicciones = preds.slice(0, 10).map(function (p) {
        return { titulo: p.title, fin: p.ended_at, acertaron: (p.ganadores || []).length };
      });
    } catch (e) { informe.muestra.predicciones = "error: " + (e && e.message ? e.message : "sin detalle"); }
  } else {
    informe.muestra.predicciones = "falta el enlace con panel-stream-azmeyn";
  }
  // Cuántos subs ve hoy (sirve para comprobar el permiso de Twitch antes del primer domingo)
  try {
    const subs = await env.PANEL_STREAM.subsActuales();
    informe.muestra.subs = { cantidad: subs.length, primeros: subs.slice(0, 5) };
  } catch (e) { informe.muestra.subs = "error: " + (e && e.message ? e.message : "sin detalle"); }
}

/* --------------------------------- Entrada --------------------------------- */
export async function ticketsAuto(env, h, prueba) {
  const informe = {
    prueba: !!prueba,
    hora: new Date(Date.now()).toISOString(),
    canjes: { vistos: 0, sumados: [], devueltos: [], fueraDeFecha: [], raros: [], otrosItems: {} },
    predicciones: { vistas: 0, procesadas: [] },
    subs: { semanas: [], sumados: [], nota: null },
    errores: [],
    revisar: []
  };
  if (!env.CHECKINS) { informe.errores.push("falta el KV CHECKINS"); return informe; }
  if (!env.SE_JWT || !env.SE_CHANNEL_ID) {
    informe.errores.push("faltan SE_JWT o SE_CHANNEL_ID");
    return informe;
  }
  h = conMemoria(h);
  try { await procesarCanjes(env, h, prueba, informe); } catch (e) { informe.errores.push("canjes: " + e.message); }
  try { await procesarPredicciones(env, h, prueba, informe); } catch (e) { informe.errores.push("predicciones: " + e.message); }
  try { await procesarSubs(env, h, prueba, informe); } catch (e) { informe.errores.push("subs: " + (e && e.message ? e.message : "sin detalle")); }
  if (prueba) { await muestra(env, informe); }
  if (!prueba && informe.revisar.length) {
    try {
      const previos = (await env.CHECKINS.get("auto:revisar", "json")) || [];
      const nuevos = informe.revisar.map(function (t) { return informe.hora + " · " + t; });
      await h.kvPut(env, "auto:revisar", JSON.stringify(previos.concat(nuevos).slice(-50)), { expirationTtl: DIAS_RECUERDO * 86400 });
    } catch (e) { informe.errores.push("no pude guardar la lista para revisar"); }
  }
  if (!prueba) {
    // Se guarda solo si pasó algo, o si el último informe es viejo (así se ve que el cron sigue vivo
    // sin gastar una escritura de KV cada 5 minutos).
    const hubo = informe.canjes.sumados.length || informe.canjes.devueltos.length || informe.canjes.fueraDeFecha.length ||
      informe.canjes.raros.length || informe.predicciones.procesadas.length || informe.subs.sumados.length || informe.errores.length;
    let viejo = true;
    if (!hubo) {
      const previo = await env.CHECKINS.get("auto:ultimo", "json");
      viejo = !previo || !(Date.now() - Date.parse(previo.hora) < LATIDO_HORAS * 3600000);
    }
    if (hubo || viejo) {
      await h.kvPut(env, "auto:ultimo", JSON.stringify(informe), { expirationTtl: DIAS_RECUERDO * 86400 });
    }
  }
  return informe;
}

export async function ticketsAutoRuta(url, env, h) {
  if (!env.ADMIN_KEY || !h.same(url.searchParams.get("key"), env.ADMIN_KEY)) {
    return new Response("No autorizado", { status: 401 });
  }
  let cuerpo;
  if (url.searchParams.get("ultimo") === "1") {
    cuerpo = (await env.CHECKINS.get("auto:ultimo", "json")) || { nota: "todavía no corrió ninguna vuelta" };
    cuerpo.paraRevisarAMano = (await env.CHECKINS.get("auto:revisar", "json")) || [];
  } else {
    // Por defecto es PRUEBA (no suma nada). Para correr de verdad hay que pedirlo con &ejecutar=1.
    const real = url.searchParams.get("ejecutar") === "1" && url.searchParams.get("prueba") !== "1";
    cuerpo = await ticketsAuto(env, h, !real);
    if (!real) { cuerpo.aviso = "Modo prueba: no se sumó nada. Para correr de verdad agregá &ejecutar=1 a la dirección."; }
  }
  return new Response(JSON.stringify(cuerpo, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
