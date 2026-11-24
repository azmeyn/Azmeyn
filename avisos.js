// Avisos de videos nuevos (Reel de Instagram, TikTok, Short de YouTube).
// Etapa 1: POST /api/avisar publica el video en #clips-y-videos de Discord (webhook) y guarda el último aviso.
// Etapas siguientes (todavía no activas): /api/aviso-twitch y /api/aviso-kick para los timers.
//
// Variables que hay que cargar en Cloudflare (Settings > Variables and Secrets, tipo "Secret"):
//   VIDEO_KEY               clave tuya para la página /avisar (inventala larga, distinta de ADMIN_KEY)
//   DISCORD_WEBHOOK_VIDEOS  webhook del canal #clips-y-videos (Discord > Configuración del canal > Integraciones)
// Usa el KV que ya existe (binding CHECKINS) con la clave "video:last".
// Si falta algo, solo /api/avisar avisa qué falta; el resto del sitio anda igual.

const PLATAFORMAS = {
  tiktok:    { nombre: "TikTok",    emoji: "🎵", hosts: ["tiktok.com"] },
  instagram: { nombre: "Instagram", emoji: "📸", hosts: ["instagram.com"] },
  youtube:   { nombre: "YouTube",   emoji: "▶️", hosts: ["youtube.com", "youtu.be"] }
};

// Frases de entrada para Discord. Se elige una según el título, así cada video queda distinto
// pero el mismo título siempre da el mismo texto (vista previa y publicación coinciden).
const INTROS_DISCORD = [
  "Salió video nuevo en {plat} 👀",
  "Subí uno nuevo a {plat}, pasen a verlo 🔥",
  "Clip fresquito en {plat} 🎬",
  "Nuevo en {plat}, miren esto 👇"
];

function respuesta(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function iguales(a, b) {
  if (!a || !b || a.length !== b.length) { return false; }
  let r = 0;
  for (let i = 0; i < a.length; i++) { r |= a.charCodeAt(i) ^ b.charCodeAt(i); }
  return r === 0;
}

function hash(texto) {
  let h = 0;
  for (let i = 0; i < texto.length; i++) { h = (h * 31 + texto.charCodeAt(i)) >>> 0; }
  return h;
}

// Saca menciones y saltos de línea para que un título raro no ping-ee a nadie ni rompa el formato.
function limpiarTexto(t, max) {
  return String(t || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/@(everyone|here)/gi, "@​$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function validarLink(link, plataforma) {
  let u;
  try { u = new URL(String(link || "").trim()); } catch (e) { return ""; }
  if (u.protocol !== "https:") { return ""; }
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, "").replace(/^vm\.|^vt\./, "");
  const ok = PLATAFORMAS[plataforma].hosts.some(function (h) { return host === h || host.endsWith("." + h); });
  return ok ? u.toString() : "";
}

function textoDiscord(v) {
  const p = PLATAFORMAS[v.plataforma];
  const intro = INTROS_DISCORD[hash(v.titulo) % INTROS_DISCORD.length].replace("{plat}", p.nombre);
  const lineas = [p.emoji + " " + intro, "**" + v.titulo + "**"];
  if (v.gancho) { lineas.push("_" + v.gancho + "_"); }
  lineas.push(v.link);
  return lineas.join("\n");
}

async function avisar(request, env) {
  if (request.method !== "POST") { return respuesta({ ok: false, error: "Usá POST desde la página /avisar" }, 405); }
  if (!env.VIDEO_KEY) { return respuesta({ ok: false, error: "Falta cargar el Secret VIDEO_KEY en Cloudflare" }, 500); }
  if (!iguales(request.headers.get("x-video-key"), env.VIDEO_KEY)) { return respuesta({ ok: false, error: "Clave incorrecta" }, 401); }

  let b;
  try { b = await request.json(); } catch (e) { return respuesta({ ok: false, error: "No pude leer los datos" }, 400); }

  const plataforma = String(b.plataforma || "").toLowerCase();
  if (!PLATAFORMAS[plataforma]) { return respuesta({ ok: false, error: "Elegí plataforma: tiktok, instagram o youtube" }, 400); }
  const titulo = limpiarTexto(b.titulo, 120);
  if (!titulo) { return respuesta({ ok: false, error: "Falta el título" }, 400); }
  const link = validarLink(b.link, plataforma);
  if (!link) { return respuesta({ ok: false, error: "El link no es https de " + PLATAFORMAS[plataforma].nombre }, 400); }
  const gancho = limpiarTexto(b.gancho, 140);

  const v = { plataforma: plataforma, titulo: titulo, gancho: gancho, link: link, ts: Date.now() };
  const texto = textoDiscord(v);

  // Vista previa: devuelve lo que saldría, sin publicar ni guardar nada
  if (b.vista_previa) { return respuesta({ ok: true, vista_previa: true, discord: texto }); }

  if (!env.DISCORD_WEBHOOK_VIDEOS) { return respuesta({ ok: false, error: "Falta cargar el Secret DISCORD_WEBHOOK_VIDEOS en Cloudflare" }, 500); }
  let r;
  try {
    r = await fetch(env.DISCORD_WEBHOOK_VIDEOS, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: texto, allowed_mentions: { parse: [] } })
    });
  } catch (e) {
    return respuesta({ ok: false, error: "No pude conectar con Discord" }, 502);
  }
  if (!r.ok) { return respuesta({ ok: false, error: "Discord respondió " + r.status + " (revisá que el webhook sea el de #clips-y-videos)" }, 502); }

  // Guarda el último video para los timers (etapas 2 y 3). Si el KV falla, Discord ya salió: se avisa igual.
  let guardado = false;
  if (env.CHECKINS) {
    try { await env.CHECKINS.put("video:last", JSON.stringify(v)); guardado = true; } catch (e) { guardado = false; }
  }
  return respuesta({ ok: true, discord: texto, guardado: guardado });
}

export async function handleAvisos(request, env, url) {
  try {
    if (url.pathname === "/api/avisar") { return await avisar(request, env); }
  } catch (e) {
    return respuesta({ ok: false, error: "Error interno, probá de nuevo en un rato" }, 500);
  }
  return null;
}

// Para las pruebas locales y las etapas siguientes
export { PLATAFORMAS, textoDiscord, validarLink, limpiarTexto, hash };
