# ECI Tracker

Histórico de precios de **El Corte Inglés**, al estilo camelcamelcamel.

1. Instalas la **extensión de Chrome** y, en la ficha de cualquier producto de elcorteingles.es, pulsas **«📉 Seguir precio»**.
2. El servidor consulta ese producto **una vez al día** y guarda el precio.
3. En la **web** ves los productos seguidos (los que han bajado de precio salen arriba, en «Ofertas»), y en cada ficha un **gráfico** con el precio actual, mínimo, máximo y medio.
4. Cualquiera puede apuntar su **email** a un producto: cuando baja de precio respecto al día anterior, se encola un email para cada suscriptor.

Sin usuarios ni registro: todos los productos que añade cualquiera pasan a ser de todos.

## Arquitectura

```
extension/   Extensión Chrome (Manifest V3): botón en ECI + opciones (URL del servidor)
server/      Node 24 + Fastify + SQLite (node:sqlite, sin dependencias nativas)
  src/         API, scraper, comprobación diaria (cron), cola de emails
  public/      Web estática (vanilla JS + Chart.js)
  test/        Tests (node:test)
Dockerfile · docker-compose.yml
```

- **Scraper**: descarga la página del producto con cabeceras de navegador (sin ellas ECI responde 403) y lee el precio del JSON-LD `Product` (`offers.price`).
- **Un precio por producto y día** (`prices`, clave `product_id + day`, en la zona horaria `TZ`).
- **Oferta** = precio que ha bajado en los últimos 7 días y no ha vuelto a subir.
- **Alertas**: al registrar el precio del día, si es menor que el último día anterior registrado se insertan los emails en `email_queue`; un worker los envía cada 30 s (lotes de 20, 1 s entre emails, 5 reintentos).
- **ID de producto**: sale de la URL, p. ej. `A202047813-8806097827146`. Cada variante (color, talla…) es un producto distinto.

## Desarrollo local

Requiere Node ≥ 24.

```powershell
cd server
npm install
npm test
$env:MAIL_DRY_RUN = "1"   # los emails se escriben en el log en vez de enviarse
npm start                 # http://localhost:3000 (la BD se crea en server/data/)
```

Lanzar la comprobación diaria sin esperar al cron: define `ADMIN_TOKEN` y haz
`POST /api/admin/check` con la cabecera `x-admin-token`. (O `CHECK_ON_START=true`.)

### Extensión de Chrome

1. `chrome://extensions` → activa **Modo desarrollador** → **Cargar descomprimida** → carpeta `extension/`.
2. En la pantalla de opciones que se abre, pon la URL de tu servidor (`http://localhost:3000` o la pública).
3. Entra en una ficha de producto de elcorteingles.es: aparece el botón abajo a la derecha.

## Despliegue con Portainer (continuo desde GitHub)

1. Sube este repo a GitHub.
2. En Portainer: **Stacks → Add stack → Repository**.
   - Repository URL: la de tu repo (si es privado, activa *Authentication* con un token).
   - Reference: `refs/heads/main` · Compose path: `docker-compose.yml`.
3. Activa **GitOps updates**: *Polling* (cada X minutos) o *Webhook* (pégalo en Settings → Webhooks del repo en GitHub, evento *push*). Marca **Re-pull image and redeploy** para que reconstruya la imagen en cada cambio.
4. En **Environment variables** define como mínimo `PUBLIC_URL` y las `SMTP_*` (ver `.env.example`).
5. Deploy. Los datos viven en el volumen `eci-data` (`/data/eci.db`) y sobreviven a los redeploys.

Pon un reverse proxy con HTTPS delante (Nginx Proxy Manager, Traefik, Caddy…) y `TRUST_PROXY=true`. La extensión debe apuntar a esa URL pública.

> **Backup**: copia el volumen `eci-data` (o `/data/eci.db*`) de vez en cuando.

## Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:3000` | URL pública (enlaces de los emails) |
| `TZ` | `Europe/Madrid` | Zona horaria del cron y de «el día» |
| `CHECK_CRON` | `0 7 * * *` | Cuándo se comprueban los precios |
| `CHECK_ON_START` | `false` | Comprobar al arrancar |
| `REQUEST_DELAY_MIN_MS` / `MAX` | `2000` / `6000` | Pausa aleatoria entre peticiones a ECI |
| `TRUST_PROXY` | `false` | `true` detrás de reverse proxy |
| `ADMIN_TOKEN` | vacío | Habilita `POST /api/admin/check` |
| `SMTP_HOST/PORT/SECURE/USER/PASS` | — | Servidor SMTP. Sin él, los emails quedan en cola |
| `MAIL_FROM` | `ECI Tracker <no-reply@localhost>` | Remitente |
| `MAIL_DRY_RUN` | `false` | Escribe los emails en el log en vez de enviarlos |

## API

| Método | Ruta | |
|---|---|---|
| `GET` | `/api/products?q=&deals=1` | Listado (con precio actual y datos de oferta) |
| `GET` | `/api/products/:id` | Ficha: estadísticas + histórico |
| `POST` | `/api/products` | `{url, name?, image?, price?}` — añade un producto |
| `POST` | `/api/products/:id/subscribe` | `{email}` — alerta de bajada |
| `GET` | `/api/unsubscribe?token=` | Baja (enlace en cada email) |

## Limitaciones conocidas

- ECI puede cambiar su web o endurecer el anti-bot; si el scraper deja de funcionar, verás el error en la ficha del producto y en los logs. Ver [TODO.md](TODO.md).
- El precio que envía la extensión sólo se usa como **primer punto** del histórico; después manda el scraper.
- Es un proyecto personal, no afiliado a El Corte Inglés. Consulta sus condiciones de uso antes de exponerlo públicamente.
