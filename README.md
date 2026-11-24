<p align="center"><img src="docs/logo.png" alt="ECI Tracker" width="220"></p>

# ECI Tracker

Histórico de precios de **El Corte Inglés**, al estilo camelcamelcamel. Pensado para desplegarse por cuenta propia (self-hosted).

> **Aviso:** proyecto personal y no oficial. **No está afiliado, patrocinado ni respaldado por El Corte Inglés**; «El Corte Inglés» y su logotipo son marcas de sus titulares y aquí sólo se nombran para indicar con qué sitio funciona. No se alojan ni se redistribuyen sus imágenes ni sus contenidos (sólo se guarda la URL de la imagen y el precio). Quien lo despliegue es responsable de su uso y de cumplir las condiciones de uso del sitio y la normativa aplicable (p. ej. RGPD si guarda emails de otras personas). Se ofrece «tal cual», sin garantías (licencia MIT).

1. Instalas la **extensión** (Chrome o Firefox) y, en la ficha de cualquier producto de elcorteingles.es, pulsas **«📉 Seguir precio»**.
2. El servidor consulta ese producto **una vez al día** y guarda el precio.
3. En la **web** ves los productos seguidos (arriba, las **ofertas**: los que han bajado de precio), con filtros por categoría, orden y buscador. Cada ficha tiene un **gráfico** con el precio actual, mínimo, máximo y medio.
4. Cualquiera puede apuntar su **email** a un producto. Tras confirmarlo, recibe un aviso cuando baja de precio respecto al día anterior, o cuando llega a un **precio objetivo** que haya fijado.

Sin usuarios ni registro: todos los productos que añade cualquiera pasan a ser de todos.

## Arquitectura

```
extension/   Extensión (Manifest V3): botón en ficha, mini botón en listados, popup, opciones
  tools/       icons.mjs (genera los iconos) · pack.mjs (zips para Chrome y Firefox)
server/      Node 24 + Fastify + SQLite (node:sqlite, sin dependencias nativas)
  src/         API, scraper, comprobación diaria (cron), cola de emails, backups
  public/      Web estática (vanilla JS + Chart.js)
  scripts/     seed-demo.js · bench-listing.js (datos sintéticos y medición del listado)
  test/        Tests (node:test)
Dockerfile · docker-compose.yml · .github/workflows/ci.yml
```

- **Scraper**: descarga la ficha con cabeceras de navegador (sin ellas ECI responde 403) y lee el JSON-LD: `Product` en los productos de catálogo y `ProductGroup` (una variante por talla) en los de marketplace. Reintenta con backoff ante 429/5xx/timeouts.
- **Un precio por producto y día** (`prices`, clave `product_id + day`, en la zona horaria `TZ`).
- **ID de producto**: sale de la URL. Catálogo: `A202047813-8806097827146`. Marketplace: `MP_0538405_NF0A8FXA` (vendedor + SKU; el color y el nombre no cuentan). Cada variante de catálogo (color, talla…) es un producto distinto.
- **Oferta** = precio que ha bajado en los últimos 7 días y no ha vuelto a subir.
- **Categorías**: se leen del `BreadcrumbList` de la ficha (p. ej. Electrónica › Móviles y Smartphones). Nivel 1 = categoría, nivel 2 = subcategoría; la portada las filtra con chips (`/?cat=…&sub=…`).
- **Estado del producto**: `status` (`active`/`gone`), `inStock` y `originalPrice` (precio tachado de ECI). Un 404/410 repetido (`GONE_AFTER` días distintos) marca el producto como descatalogado: se deja de consultar cada día (se sondea cada `GONE_RECHECK_DAYS` por si vuelve) y se conserva el histórico. Sin stock no se registra precio.
- **Alertas de precio** (doble opt-in): al apuntarse, llega un email de confirmación. Sólo las suscripciones confirmadas reciben avisos. Sin objetivo se avisa cuando el precio baja respecto al último día registrado; con `targetPrice` se avisa una vez al cruzarlo (precio ≤ objetivo) y se rearma si vuelve a subir por encima. Las suscripciones sin confirmar caducan (`CONFIRM_TTL_DAYS`). Cada email lleva enlaces de baja (de ese producto o de todo) y cabeceras `List-Unsubscribe` (baja en un clic, RFC 8058). Los enlaces del email sólo muestran una página con un botón: el cambio se hace con POST, para que un escáner de enlaces no confirme ni dé de baja nada. Hay un tope de emails de confirmación por dirección y día.
- **Cola de emails**: un worker los envía cada 30 s (lotes de 20, 1 s entre emails, 5 reintentos). Los enviados y fallidos antiguos se purgan.
- **Seguridad de la API pública**: cuerpo y campos de `POST /api/products` validados y con límites por IP (minuto, día y productos nuevos por día, usando `CF-Connecting-IP` detrás de un proxy de confianza); cabeceras de seguridad (CSP estricta, `nosniff`, `X-Frame-Options`, HSTS…).

## Desarrollo local

Requiere Node ≥ 24.

```powershell
cd server
npm install
npm test
$env:MAIL_DRY_RUN = "1"   # los emails se escriben en el log en vez de enviarse
npm start                 # http://localhost:3000 (la BD se crea en server/data/)
```

Lanzar la comprobación diaria sin esperar al cron: define `ADMIN_TOKEN` y haz `POST /api/admin/check` con la cabecera `x-admin-token`. (O `CHECK_ON_START=true`.) Estadísticas de las últimas pasadas: `GET /api/admin/stats` con la misma cabecera.

Datos de prueba y medición del listado:

```powershell
node scripts/seed-demo.js ./demo.db 300 90   # 300 productos, 90 días de histórico
node scripts/bench-listing.js ./demo.db
```

### Extensión

La propia web ofrece el botón **«🧩 Instalar extensión»** (cabecera): abre un modal con las instrucciones para Chrome/Edge/Brave y Firefox y descarga los `.zip`, que el `Dockerfile` genera con `extension/tools/pack.mjs` y sirve en `/downloads/`. El modal muestra también la URL del servidor para pegarla en las opciones. A mano:

**Chrome / Brave / Edge**: `chrome://extensions` → **Modo desarrollador** → **Cargar descomprimida** → carpeta `extension/`.

**Firefox**: `node extension/tools/pack.mjs` genera `extension/dist/eci-tracker-firefox.zip` (y el de Chrome); en `about:debugging` → *Este Firefox* → *Cargar complemento temporal*.

1. En la pantalla de opciones que se abre, pon la URL de tu servidor (`http://localhost:3000` o la pública).
2. En una ficha de producto de elcorteingles.es aparece el botón «Seguir precio» abajo a la derecha (si ya se sigue, muestra su precio y el mínimo). El icono de la extensión abre un popup con lo mismo. En los listados (búsqueda, favoritos, categorías) aparece **«Seguir todos (N)»**: envía de una vez los productos de la página al servidor (máx. 100), que los va leyendo en segundo plano, así que puedes cerrar la página.
3. En listados, búsquedas y favoritos aparece un mini botón 📉 arriba a la izquierda de cada tarjeta; los productos que ya están en el tracker salen con ✓ (clic = abrir su historial).

Los iconos se regeneran con `node extension/tools/icons.mjs`.

## Despliegue con Docker / Portainer

```powershell
docker compose up --build -d     # http://localhost:3000
```

Con Portainer (despliegue continuo desde un repositorio Git):

1. **Stacks → Add stack → Repository**: URL del repo (si es privado, activa *Authentication* con un token), referencia `refs/heads/main`, compose path `docker-compose.yml`.
2. Activa **GitOps updates**: *Polling* o *Webhook* (evento *push*). Marca **Re-pull image and redeploy** para que reconstruya la imagen en cada cambio.
3. En **Environment variables** define como mínimo `PUBLIC_URL` y las `SMTP_*` (ver `.env.example`).
4. Los datos viven en el volumen `eci-data` (`/data/eci.db`) y sobreviven a los redeploys.

Pon un reverse proxy o túnel con HTTPS delante y `TRUST_PROXY=true`. La extensión debe apuntar a esa URL. Si la entrada es un túnel que llega por `172.17.0.1`, usa `BIND_ADDR=172.17.0.1` para no exponer el puerto a la red local. Si cambias el historial del repositorio (force-push), puede ser necesario redesplegar el stack a mano.

### Backups

Cada noche (`BACKUP_CRON`) se hace una copia consistente de la base con `VACUUM INTO` en `BACKUP_DIR`, y se conservan las últimas `BACKUP_KEEP`. Por defecto van a un volumen aparte (`eci-backups`); para protegerte de perder el disco, pon `BACKUP_PATH` a una ruta del host en **otro** disco.

**Restaurar**: para el contenedor, copia el `eci-AAAAMMDD-HHMMSS.db` más reciente de `/data/backups` a `/data/eci.db`, borra `/data/eci.db-wal` y `/data/eci.db-shm`, y arranca.

## Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:3000` | URL pública (enlaces de los emails) |
| `TZ` | `Europe/Madrid` | Zona horaria del cron y de «el día» |
| `CHECK_CRON` | `0 7 * * *` | Cuándo se comprueban los precios |
| `CHECK_ON_START` | `false` | Comprobar al arrancar |
| `REQUEST_DELAY_MIN_MS` / `MAX` | `2000` / `6000` | Pausa aleatoria entre peticiones a ECI |
| `SCRAPE_RETRIES` / `SCRAPE_BACKOFF_MS` | `2` / `3000` | Reintentos y backoff base ante 429/5xx/timeouts |
| `GONE_AFTER` | `3` | Días distintos con 404/410 para marcar un producto como descatalogado |
| `GONE_RECHECK_DAYS` | `7` | Cada cuántos días se sondea un producto descatalogado (`0` = nunca) |
| `BIND_ADDR` | `0.0.0.0` | Interfaz del host donde se publica el puerto |
| `TRUST_PROXY` | `false` | `true` detrás de proxy/túnel; el rate limit usa entonces `CF-Connecting-IP` |
| `ADMIN_TOKEN` | vacío | Habilita `POST /api/admin/check` y `GET /api/admin/stats` |
| `ADMIN_EMAIL` | vacío | Recibe un aviso si una pasada diaria falla en bloque (máx. 1 al día) |
| `ADMIN_ALERT_FAIL_PCT` / `ADMIN_ALERT_MIN_SAMPLE` | `50` / `3` | Umbral del aviso al admin (% de fallos y mínimo de intentos) |
| `SMTP_HOST/PORT/SECURE/USER/PASS` | — | Servidor SMTP. Sin él, los emails quedan en cola |
| `MAIL_FROM` | `ECI Tracker <no-reply@localhost>` | Remitente |
| `MAIL_DRY_RUN` | `false` | Escribe los emails en el log en vez de enviarlos |
| `CONFIRM_TTL_DAYS` | `7` | Días que caduca una suscripción sin confirmar |
| `CONFIRM_MAX_PER_EMAIL_DAY` | `5` | Máx. emails de confirmación por dirección en 24 h |
| `QUEUE_SENT_RETENTION_DAYS` / `QUEUE_FAILED_RETENTION_DAYS` | `30` / `60` | Purga de la cola de emails |
| `BACKUP_CRON` | `30 3 * * *` | Cuándo se hace el backup (`off` lo desactiva) |
| `BACKUP_DIR` / `BACKUP_KEEP` | `/data/backups` / `7` | Carpeta y nº de copias a conservar |
| `BACKUP_PATH` | volumen `eci-backups` | Ruta del host para los backups (bind mount) |
| `TRACK_PER_MINUTE` / `TRACK_PER_DAY` | `30` / `200` | Límites por IP de `POST /api/products` |
| `TRACK_NEW_PER_DAY` | `0` | Productos nuevos por IP y día (`0` = sin límite; ponlo si abres el servicio a más gente) |
| `BULK_MAX_ITEMS` / `BULK_PER_MINUTE` | `100` / `5` | Alta masiva: máximo de productos por petición y peticiones por minuto y IP. Cada producto cuenta para `TRACK_PER_DAY` y `TRACK_NEW_PER_DAY` |
| `SCRAPE_QUEUE_MAX` | `300` | Tope de productos nuevos pendientes de primera lectura; con la cola llena el alta masiva responde 429 |
| `SUBSCRIBE_PER_MINUTE` | `10` | Límite por IP de las suscripciones |

## API

| Método | Ruta | |
|---|---|---|
| `GET` | `/api/products?q=&deals=1&cat=&sub=&sort=&page=&limit=` | Listado paginado → `{products, total, page, limit, pages, categories}`. `sort`: `drop` · `recent` · `price_asc` · `price_desc` · `near_min`. `limit` ≤ 100. `cat=Sin categoría` filtra los que no la tienen |
| `GET` | `/api/products/:id` | Ficha: estadísticas, histórico, `status`, `inStock`, `originalPrice`, `categoryPath` |
| `POST` | `/api/products` | `{url, name?, image?, price?}` — añade un producto (cualquier otro campo da 400) |
| `POST` | `/api/products/bulk` | `{items:[{url, name?, image?, price?}]}` (1–100) — alta masiva; responde `{added, existing, invalid, queued, results}`. Los precios se leen en segundo plano, a ritmo educado |
| `GET` | `/api/tracked?ids=A1,MP_2_X` | Cuáles de esos ids ya están en el tracker (máx. 100) |
| `POST` | `/api/products/:id/subscribe` | `{email, targetPrice?}` — pide la alerta; envía el email de confirmación |
| `GET`/`POST` | `/api/confirm?token=` | GET muestra la página con el botón; POST confirma |
| `GET`/`POST` | `/api/unsubscribe?token=` | Baja de un producto (POST con `List-Unsubscribe=One-Click` = baja en un clic) |
| `GET`/`POST` | `/api/unsubscribe-all?token=` | Baja de todas las alertas de ese email |
| `POST` | `/api/admin/check` | Lanza la comprobación diaria (cabecera `x-admin-token`) |
| `GET` | `/api/admin/stats` | Contadores, cola de email y últimas pasadas (cabecera `x-admin-token`) |

## Uso responsable y limitaciones

- Es un proyecto personal, **no afiliado a El Corte Inglés**; «El Corte Inglés» es marca de sus titulares. Consulta sus condiciones de uso antes de ejecutarlo. El servidor consulta sólo fichas de producto, sin parámetros, a ritmo bajo (pausas entre peticiones), y no almacena sus imágenes (sólo la URL).
- Si apuntas emails de terceros, eres responsable de su tratamiento (RGPD/LOPDGDD): informa de quién eres y para qué se usan sus datos, y atiende las bajas.
- ECI puede cambiar su web o endurecer el anti-bot; si el scraper deja de funcionar, verás el error en la ficha del producto, en los logs y, si configuras `ADMIN_EMAIL`, por email. Ver [TODO.md](TODO.md).
- El precio que envía la extensión sólo se usa como **primer punto** del histórico; después manda el scraper.
- Un producto de marketplace con varias tallas se guarda con el precio más bajo entre las tallas con stock.

## Licencia

[MIT](LICENSE).
