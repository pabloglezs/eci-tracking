# TODO

## Hecho
- [x] Estructura del repo, Dockerfile y docker-compose; build y arranque probados en local
- [x] Backend: SQLite, API REST, scraper JSON-LD (catálogo y marketplace), comprobación diaria (cron), cola de emails
- [x] Web: portada con bloque de ofertas, listado paginado con orden, buscador, categorías, sparkline y alta por URL; ficha con gráfico (actual / mín / máx / medio) y suscripción
- [x] Extensión (Chrome y Firefox): botón en ficha, popup con el estado del producto, mini botón 📉/✓ en listados, búsquedas y favoritos, iconos y empaquetado
- [x] Alertas: doble opt-in (confirmación por POST), precio objetivo, «darme de baja de todo», baja en un clic, tope de confirmaciones por email, purga de la cola
- [x] Scraper: reintentos con backoff, descatalogados, sin stock, precio tachado, aviso al admin y métricas (`/api/admin/stats`)
- [x] Seguridad: validación y límites por IP de la API pública, cabeceras (CSP estricta), `CF-Connecting-IP` detrás del túnel
- [x] Mantenimiento: backups automáticos de SQLite (con restauración probada) y CI en GitHub Actions
- [x] Tests (unitarios, flujo de alertas, API, listado, scraper)

## Antes de publicarlo de verdad
- [ ] **Desplegar en Portainer esta versión** y comprobar: categorías, marketplace, doble opt-in y backups (copia antes `/data/eci.db`: las migraciones añaden columnas y tablas)
- [ ] Configurar SMTP real y probar un envío (dominio con SPF/DKIM para no caer en spam); comprobar que llegan las cabeceras `List-Unsubscribe`
- [ ] Activar *Always Use HTTPS* en Cloudflare (que `http://` redirija a HTTPS)
- [ ] Ejecutar el workflow de CI en GitHub y comprobar que pasa
- [ ] Publicar la extensión (Chrome Web Store / Firefox Add-ons) o distribuir el zip
- [ ] Si el repositorio va a ser público: revisar los aspectos legales (condiciones de uso de ECI, uso de su marca en el nombre del proyecto, RGPD/LOPDGDD de los emails), página de privacidad y aviso de no afiliación

## Pendientes de producto
- [ ] Mostrar `originalPrice` (precio tachado) y `inStock` en la web: el servidor ya los devuelve
- [ ] Filtro «en su mínimo histórico»
- [ ] Mostrar en la ficha si el producto está descatalogado (`status = gone`)
- [ ] Resumen semanal por email (opcional, aplazado)
- [ ] Captcha ligero en las altas si hay abuso

## Robustez / decisiones aplazadas
- [ ] **Playwright** (navegador headless) como fallback si ECI empieza a bloquear el `fetch` (403 con cabeceras de navegador): decidir solo si ocurre
- [ ] **Proxy / rotación de IP** si hace falta con muchos productos (aplazado)
- [ ] Los contadores diarios de la API (límite por IP y día) están en memoria y se reinician con el contenedor; si hace falta, persistirlos
- [ ] Índice cubriente en `prices` para acelerar el listado con decenas de miles de productos (medido: ~230 ms con 5000 productos × 90 días)
- [ ] Probar el comportamiento ante un 429 real de ECI (el backoff solo está probado con tests)
- [ ] Criterio de variantes de color de marketplace (la extensión asume que comparten prefijo de SKU; no verificado)
- [ ] Probar el flujo completo con la extensión cargada contra el servidor desplegado (alta de un producto de marketplace desde favoritos)
