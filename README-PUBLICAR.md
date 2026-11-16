# Cómo publicar el sitio de Azmeyn gratis (Cloudflare Pages)

## Archivos
```
index.html            Sitio principal (inicio, directo, redes, evento, contacto)
soloboom.html         Tienda de puntos del SoloBoom Challenge 6 (apartado aparte)
functions/api/live.js Función que consulta Twitch y Kick (estado en vivo)
```
Los tres tienen que subirse juntos, con esa misma estructura de carpetas.

## 1. Subirlo a GitHub (gratis)
1. Creá una cuenta en github.com y un repositorio nuevo (por ejemplo `azmeyn-web`).
2. Subí `index.html`, `soloboom.html` y la carpeta `functions` (con `api/live.js` adentro).

## 2. Conectarlo a Cloudflare Pages (gratis)
1. Creá una cuenta en dash.cloudflare.com.
2. Workers & Pages > Create > Pages > Connect to Git, y elegí el repositorio.
3. Build command: dejalo vacío. Output directory: `/` (la raíz).
4. Deploy. Te da una dirección tipo `azmeyn.pages.dev`.

Cada vez que cambies un archivo en GitHub, el sitio se actualiza solo.

## 3. Activar el estado online/offline
Sin este paso el sitio funciona igual, pero las etiquetas dicen "ver canal" en lugar de "en vivo" u "offline", y la caja "Ahora" y los últimos directos no aparecen.

**Twitch**
1. Entrá a dev.twitch.tv/console con tu cuenta y creá una aplicación.
2. Redirect URL: `http://localhost`. Categoría: Website Integration.
3. Copiá el Client ID y generá un Client Secret.

**Kick**
1. En Kick, abrí Configuración > Developer y creá una aplicación.
2. Copiá el Client ID y el Client Secret.

**Cargarlos en Cloudflare**
Pages > tu proyecto > Settings > Variables and Secrets. Agregá estas cuatro (las secretas como "Secret"):

| Nombre | Valor |
|---|---|
| TWITCH_CLIENT_ID | el de Twitch |
| TWITCH_CLIENT_SECRET | el de Twitch |
| KICK_CLIENT_ID | el de Kick |
| KICK_CLIENT_SECRET | el de Kick |

Tus canales son `twitch.tv/azmeyn` y `kick.com/meyn`, que ya vienen cargados. Si algún día cambian, agregá también `TWITCH_LOGIN` y `KICK_SLUG` en Cloudflare, y cambiá el nombre en el bloque `CONFIG` al final de `index.html` y de `soloboom.html`. Después volvé a desplegar.

**Importante:** el Client Secret es como una contraseña. No lo pegues en `index.html` ni lo subas a GitHub; solo va en Cloudflare.

## 4. Dominio propio (opcional)
El sitio funciona con la dirección gratuita `.pages.dev`. Si más adelante querés `azmeyn.com`, se compra aparte (unos USD 10 al año) y se conecta desde Pages > Custom domains.

## Cambiar textos
Los textos están escritos directamente en `index.html` y `soloboom.html`. Desde GitHub, sin instalar nada:
1. Abrí el archivo en tu repositorio y tocá el lápiz (Edit this file).
2. Con Ctrl+F buscá la frase que querés cambiar y reemplazala.
3. "Commit changes". En 1 o 2 minutos el sitio se actualiza solo.

Tocá solo el texto: no borres lo que está entre `<` y `>`.

Datos que se cambian en un solo lugar:
- **Premios, costos y stock:** lista `ITEMS` al final de `soloboom.html`. El stock es un número fijo (`null` = sin límite, `0` = agotado).
- **Fechas y estado de los sorteos:** lista `DRAWS` al final de `soloboom.html`. El estado (Próximo, Activo, Finalizado) se calcula solo con la fecha.
- **Fechas del evento en el inicio:** `data-start` y `data-days` en el bloque `event` de `index.html`.
- **Canales:** bloque `CONFIG` al final de `index.html` y el mismo bloque en `soloboom.html` (la tienda también muestra si estás en vivo).
- **Menú lateral y barra de estado:** son iguales en `index.html` y `soloboom.html`. Si cambiás o agregás un link, hacelo en los dos archivos.
- **Enlace a la info oficial del torneo:** botón "Info oficial del torneo" en el bloque `event` de `index.html`.

## Si el reproductor no carga
- Debajo del reproductor hay un enlace "Abrir en Twitch/Kick" que siempre funciona.
- No funciona abriendo `index.html` con doble clic desde tu compu: Twitch solo deja incrustar el reproductor en una página publicada. Probalo en la dirección `.pages.dev`.
- Un bloqueador de anuncios o la protección contra rastreo del navegador puede bloquearlo. El reproductor de Kick no se probó en una página publicada: confirmalo cuando la subas.

## Cuando decidas el look
Los colores y las tipografías están en el bloque `:root` al principio del `<style>` de cada archivo. El logo provisorio es el SVG dentro de `.brand`.
