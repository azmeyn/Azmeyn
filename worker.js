// Worker de Cloudflare: responde GET /api/live
// Dice si Azmeyn está en vivo en Twitch y/o Kick y devuelve sus últimos directos de Twitch.
// El resto de las rutas (index.html, soloboom.html) las sirve Cloudflare directamente desde /public.
//
// Variables que hay que cargar en Cloudflare (Settings > Variables and Secrets, tipo "Secret"):
//   TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET   (https://dev.twitch.tv/console)
//   KICK_CLIENT_ID,   KICK_CLIENT_SECRET     (Kick > Configuración > Developer)
// Opcionales: TWITCH_LOGIN (por defecto "azmeyn") y KICK_SLUG (por defecto "meyn")
//
// Si falta alguna credencial, esa plataforma devuelve null y la página
// muestra "ver canal" en lugar de online/offline. Nunca se rompe la página.

let twitchTokenCache = null; // { value, exp }
let kickTokenCache = null;   // { value, exp }

async function getJson(res, what) {
  if (!res.ok) { throw new Error(what + " respondió " + res.status); }
  return res.json();
}

/* ------------------------------ Twitch ------------------------------ */
async function twitchToken(env) {
  if (twitchTokenCache && twitchTokenCache.exp > Date.now() + 60000) { return twitchTokenCache.value; }
  const body = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    grant_type: "client_credentials"
  });
  const j = await getJson(await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body }), "Twitch token");
  twitchTokenCache = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return twitchTokenCache.value;
}

async function twitchData(env) {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) { return null; }
  const login = (env.TWITCH_LOGIN || "azmeyn").toLowerCase();
  const token = await twitchToken(env);
  const h = { "Client-Id": env.TWITCH_CLIENT_ID, Authorization: "Bearer " + token };
  const q = encodeURIComponent(login);

  const [sRes, uRes] = await Promise.all([
    fetch("https://api.twitch.tv/helix/streams?user_login=" + q, { headers: h }),
    fetch("https://api.twitch.tv/helix/users?login=" + q, { headers: h })
  ]);
  const stream = ((await getJson(sRes, "Twitch streams")).data || [])[0];
  const user = ((await getJson(uRes, "Twitch users")).data || [])[0];

  let videos = [];
  if (user && user.id) {
    try {
      const vRes = await fetch(
        "https://api.twitch.tv/helix/videos?user_id=" + encodeURIComponent(user.id) + "&type=archive&first=8",
        { headers: h }
      );
      videos = ((await getJson(vRes, "Twitch videos")).data || []).map(function (v) {
        return {
          title: v.title,
          url: v.url,
          thumbnail: (v.thumbnail_url || "").replace("%{width}x%{height}", "320x180"),
          preview: (v.thumbnail_url || "").replace("%{width}x%{height}", "1280x720"),
          date: v.created_at
        };
      });
    } catch (e) { videos = []; }
  }

  return {
    live: !!stream && stream.type === "live",
    avatar: user ? user.profile_image_url : null,
    title: stream ? stream.title : null,
    viewers: stream ? stream.viewer_count : null,
    thumbnail: stream ? (stream.thumbnail_url || "").replace("{width}x{height}", "1280x720") : null,
    since: stream ? stream.started_at : null,
    videos: videos
  };
}

/* ------------------------------- Kick ------------------------------- */
async function kickToken(env) {
  if (kickTokenCache && kickTokenCache.exp > Date.now() + 60000) { return kickTokenCache.value; }
  const body = new URLSearchParams({
    client_id: env.KICK_CLIENT_ID,
    client_secret: env.KICK_CLIENT_SECRET,
    grant_type: "client_credentials"
  });
  const j = await getJson(await fetch("https://id.kick.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  }), "Kick token");
  kickTokenCache = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return kickTokenCache.value;
}

async function kickData(env) {
  if (!env.KICK_CLIENT_ID || !env.KICK_CLIENT_SECRET) { return null; }
  const slug = (env.KICK_SLUG || "meyn").toLowerCase();
  const token = await kickToken(env);
  const res = await fetch("https://api.kick.com/public/v1/channels?slug=" + encodeURIComponent(slug), {
    headers: { Authorization: "Bearer " + token }
  });
  const ch = ((await getJson(res, "Kick channels")).data || [])[0];
  if (!ch) { return null; }
  const s = ch.stream || {};
  return {
    live: !!s.is_live,
    title: ch.stream_title || null,
    viewers: typeof s.viewer_count === "number" ? s.viewer_count : null,
    thumbnail: s.is_live && typeof s.thumbnail === "string" ? s.thumbnail : null,
    since: s.is_live && s.start_time ? s.start_time : null
  };
}

/* ------------------------- Presente y tickets del sorteo -------------------------
   Lo usan los comandos de StreamElements (ver TUTORIAL-STREAMELEMENTS):
     /api/presente   -> !presente   (suma puntos + 1 ticket por día, con racha)
     /api/ticket-add -> !ticket+     (para moderadores: suma tickets a mano)
     /api/tickets    -> lista de tickets para los sorteos (la abrís vos en el navegador)
   Variables (tipo Secret): SE_JWT, SE_CHANNEL_ID, PRESENTE_KEY, ADMIN_KEY
   Base de datos: KV con el nombre CHECKINS (se agrega en wrangler.jsonc, ver tutorial).
   Si falta algo de esto, solo estos comandos avisan que falta configurar; el resto del sitio anda igual. */
const EVENT_START = "2026-11-30"; // primer día del torneo (hora de Argentina)
const EVENT_DAYS = 21;            // 30/11 al 20/12
const PTS_PRESENTE = 100;
const PTS_RACHA = 300;            // se suma cada vez que la racha llega a un múltiplo de 3
const RACHA_CADA = 3;
const SE_POINTS_URL = "https://api.streamelements.com/kappa/v2/points/";

function argDay(offset) {
  // Día actual en Argentina (UTC-3) con formato AAAA-MM-DD
  return new Date(Date.now() - 3 * 3600000 + (offset || 0) * 86400000).toISOString().slice(0, 10);
}
function dayIndex(day) { return Math.round((Date.parse(day) - Date.parse(EVENT_START)) / 86400000); }
function plain(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
  });
}
function cleanUser(u) {
  u = String(u || "").toLowerCase().replace(/^@/, "");
  return /^[a-z0-9_]{3,25}$/.test(u) ? u : "";
}
function same(a, b) {
  if (!a || !b || a.length !== b.length) { return false; }
  let r = 0;
  for (let i = 0; i < a.length; i++) { r |= a.charCodeAt(i) ^ b.charCodeAt(i); }
  return r === 0;
}
function emptyRec() { return { last: "", streak: 0, w: { 1: 0, 2: 0, 3: 0 } }; }
function totalOf(rec) { return (rec.w[1] || 0) + (rec.w[2] || 0) + (rec.w[3] || 0); }
async function loadRec(env, user) {
  const raw = await env.CHECKINS.get("u:" + user, "json");
  const rec = Object.assign(emptyRec(), raw || {});
  rec.w = Object.assign({ 1: 0, 2: 0, 3: 0 }, rec.w);
  return rec;
}
async function saveRec(env, user, rec) {
  await env.CHECKINS.put("u:" + user, JSON.stringify(rec), { metadata: rec });
}
async function sePoints(env, user, amount) {
  const r = await fetch(SE_POINTS_URL + encodeURIComponent(env.SE_CHANNEL_ID) + "/" + encodeURIComponent(user) + "/" + amount, {
    method: "PUT",
    headers: { Authorization: "Bearer " + env.SE_JWT, Accept: "application/json" }
  });
  if (!r.ok) { throw new Error("StreamElements respondió " + r.status); }
}
function missing(env, names) {
  return names.filter(function (n) { return !env[n]; });
}

async function presente(url, env) {
  const miss = missing(env, ["CHECKINS", "SE_JWT", "SE_CHANNEL_ID", "PRESENTE_KEY"]);
  if (miss.length) { return plain("!presente todavía no está configurado (falta " + miss.join(", ") + ")"); }
  if (!same(url.searchParams.get("key"), env.PRESENTE_KEY)) { return plain("No autorizado", 401); }
  const user = cleanUser(url.searchParams.get("user"));
  if (!user) { return plain("No pude leer tu usuario, probá de nuevo"); }

  const today = argDay(0);
  const idx = dayIndex(today);
  if (idx < 0) { return plain("@" + user + " el torneo empieza el 30/11, ahí arranca el !presente"); }
  if (idx >= EVENT_DAYS) { return plain("@" + user + " el torneo ya terminó, gracias por acompañar"); }

  const before = await loadRec(env, user);
  if (before.last === today) {
    return plain("@" + user + " ya registraste tu presente hoy ✅ · racha: " + before.streak + " · tickets: " + totalOf(before));
  }
  const rec = JSON.parse(JSON.stringify(before));
  rec.streak = before.last === argDay(-1) ? before.streak + 1 : 1;
  rec.last = today;
  const week = Math.floor(idx / 7) + 1;
  rec.w[week] = (rec.w[week] || 0) + 1;
  const bonus = rec.streak % RACHA_CADA === 0;
  const pts = PTS_PRESENTE + (bonus ? PTS_RACHA : 0);

  // Primero se anota el día y después se suman los puntos; si StreamElements falla, se deshace.
  await saveRec(env, user, rec);
  try {
    await sePoints(env, user, pts);
  } catch (e) {
    await saveRec(env, user, before);
    return plain("@" + user + " no pude sumar tus puntos ahora, probá de nuevo en un rato");
  }
  return plain("@" + user + " presente ✅ +" + pts + " pts" +
    (bonus ? " (¡racha de " + rec.streak + " días!)" : " · racha: " + rec.streak) +
    " · tickets: " + totalOf(rec));
}

async function ticketAdd(url, env) {
  const miss = missing(env, ["CHECKINS", "ADMIN_KEY"]);
  if (miss.length) { return plain("Los tickets todavía no están configurados (falta " + miss.join(", ") + ")"); }
  if (!same(url.searchParams.get("key"), env.ADMIN_KEY)) { return plain("No autorizado", 401); }
  const user = cleanUser(url.searchParams.get("user"));
  if (!user) { return plain("Uso: !ticket+ usuario [cantidad]"); }
  let n = parseInt(url.searchParams.get("n") || "1", 10);
  if (isNaN(n) || n < 1 || n > 10) { n = 1; }
  let week = parseInt(url.searchParams.get("week") || "", 10);
  if (isNaN(week)) {
    const idx = dayIndex(argDay(0));
    if (idx < 0 || idx >= EVENT_DAYS) { return plain("Fuera de las fechas del torneo: indicá la semana (1, 2 o 3)"); }
    week = Math.floor(idx / 7) + 1;
  }
  if (week < 1 || week > 3) { return plain("La semana tiene que ser 1, 2 o 3"); }
  const rec = await loadRec(env, user);
  rec.w[week] = (rec.w[week] || 0) + n;
  await saveRec(env, user, rec);
  return plain("🎟️ @" + user + " +" + n + " ticket(s) en la semana " + week + " · total: " + totalOf(rec));
}

async function ticketsList(url, env) {
  const miss = missing(env, ["CHECKINS", "ADMIN_KEY"]);
  if (miss.length) { return plain("Falta configurar " + miss.join(", "), 500); }
  if (!same(url.searchParams.get("key"), env.ADMIN_KEY)) { return plain("No autorizado", 401); }
  const wk = url.searchParams.get("week") || "all";
  const format = url.searchParams.get("format") || "json";
  const subs = (url.searchParams.get("subs") || "").split(",").map(cleanUser).filter(Boolean);

  const rows = [];
  let cursor;
  do {
    const page = await env.CHECKINS.list({ prefix: "u:", cursor: cursor });
    page.keys.forEach(function (k) {
      const rec = Object.assign(emptyRec(), k.metadata || {});
      rec.w = Object.assign({ 1: 0, 2: 0, 3: 0 }, rec.w);
      const user = k.name.slice(2);
      let t = wk === "all" ? totalOf(rec) : (rec.w[wk] || 0);
      // Solo el sorteo final duplica a los suscriptores
      const isSub = subs.indexOf(user) >= 0;
      const eff = wk === "all" && isSub ? t * 2 : t;
      if (t > 0) { rows.push({ user: user, tickets: t, effective: eff, sub: isSub }); }
    });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  rows.sort(function (a, b) { return b.effective - a.effective || (a.user < b.user ? -1 : 1); });
  if (format === "wheel") {
    // Un nombre por cada chance: pegalo tal cual en una ruleta digital
    const lines = [];
    rows.forEach(function (r) { for (let i = 0; i < r.effective; i++) { lines.push(r.user); } });
    return plain(lines.join("\n"));
  }
  if (format === "csv") {
    return plain("usuario,tickets,chances,suscriptor\n" + rows.map(function (r) {
      return r.user + "," + r.tickets + "," + r.effective + "," + (r.sub ? "si" : "no");
    }).join("\n"));
  }
  return new Response(JSON.stringify({ week: wk, participantes: rows.length, rows: rows }, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

/* ------------------------------ Handler ------------------------------ */
async function live(request, env, ctx) {
  // Caché de 30 segundos para no consultar a Twitch y Kick en cada visita
  // (la caché solo actúa con dominio propio; en workers.dev se consulta cada vez, y no pasa nada).
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(new URL(request.url).origin + "/api/live");
  if (cache) {
    const hit = await cache.match(key);
    if (hit) { return hit; }
  }

  const [t, k] = await Promise.allSettled([twitchData(env), kickData(env)]);
  const data = {
    twitch: t.status === "fulfilled" ? t.value : null,
    kick: k.status === "fulfilled" ? k.value : null
  };
  const res = new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=0, s-maxage=30"
    }
  });
  if (cache) { ctx.waitUntil(cache.put(key, res.clone())); }
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/live" && request.method === "GET") { return live(request, env, ctx); }
    if (request.method === "GET") {
      try {
        if (url.pathname === "/api/presente") { return await presente(url, env); }
        if (url.pathname === "/api/ticket-add") { return await ticketAdd(url, env); }
        if (url.pathname === "/api/tickets") { return await ticketsList(url, env); }
      } catch (e) {
        return plain("Error interno, probá de nuevo en un rato", 500);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
