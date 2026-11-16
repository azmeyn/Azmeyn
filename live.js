// Cloudflare Pages Function: responde GET /api/live
// Dice si Azmeyn está en vivo en Twitch y/o Kick y devuelve sus últimos directos de Twitch.
//
// Variables que hay que cargar en Cloudflare (Settings > Variables and Secrets):
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
          date: v.created_at
        };
      });
    } catch (e) { videos = []; }
  }

  return {
    live: !!stream && stream.type === "live",
    title: stream ? stream.title : null,
    viewers: stream ? stream.viewer_count : null,
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
    viewers: typeof s.viewer_count === "number" ? s.viewer_count : null
  };
}

/* ------------------------------ Handler ------------------------------ */
export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;

  // Caché de 30 segundos para no consultar a Twitch y Kick en cada visita.
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(new URL(request.url).origin + "/api/live");
  if (cache) {
    const hit = await cache.match(key);
    if (hit) { return hit; }
  }

  const [t, k] = await Promise.allSettled([twitchData(env), kickData(env)]);
  const body = {
    twitch: t.status === "fulfilled" ? t.value : null,
    kick: k.status === "fulfilled" ? k.value : null
  };
  const res = new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=0, s-maxage=30"
    }
  });
  if (cache) {
    const put = cache.put(key, res.clone());
    if (typeof waitUntil === "function") { waitUntil(put); } else { await put; }
  }
  return res;
}
