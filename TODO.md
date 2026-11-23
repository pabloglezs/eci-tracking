# TODO

## Hecho (v0.1)
- [x] Estructura del repo, Dockerfile y docker-compose
- [x] Backend: SQLite, API REST, scraper JSON-LD, comprobación diaria (cron), cola de emails
- [x] Web: home con ofertas + listado, ficha con gráfico (actual / mín / máx / medio) y suscripción
- [x] Extensión Chrome MV3: botón «Seguir precio» y opciones
- [x] Tests (lógica de precios, scraper, flujo bajada→cola→envío, API)

## Antes de publicarlo de verdad
- [ ] **Probar el build de Docker** y un despliegue completo en Portainer (no probado aún)
- [ ] **Doble opt-in** de email: ahora cualquiera puede apuntar el email de otra persona (mitigado con enlace de baja + rate limit)
- [ ] Reverse proxy con HTTPS y probar la extensión contra la URL pública
- [ ] Configurar SMTP real y probar un envío (dominio con SPF/DKIM para no caer en spam)
- [ ] Iconos de la extensión (16/48/128) y publicarla en Chrome Web Store (o distribuir el zip)

## Robustez del scraper
- [ ] Alertar si muchos productos fallan seguidos (ECI cambió algo / nos bloquea) — email al admin
- [ ] Reintento con backoff y fallback a Playwright (navegador headless) si fetch recibe 403
- [ ] Marcar productos descatalogados (404/410 repetidos) y dejar de consultarlos
- [ ] Capturar precio tachado / «precio anterior» de ECI y mostrarlo
- [ ] Detectar «sin stock» (`availability`) y no registrar precio erróneo
- [ ] Proxy/rotación de IP si hace falta con muchos productos

## Producto
- [ ] Alerta por **precio objetivo** («avísame si baja de X €») además de «baja respecto a ayer»
- [ ] Sparkline en las tarjetas de la home
- [x] Categorías (del breadcrumb de ECI): chips, subcategorías y agrupación en la portada
- [ ] Ordenar el listado (mayor bajada, mínimo histórico)
- [ ] Paginación (el listado carga todo; hay que paginar y optimizar la query cuando haya miles de productos)
- [ ] Añadir producto pegando la URL desde la web (sin extensión)
- [x] Popup en el icono de la extensión (seguir producto de la pestaña activa)
- [ ] Mostrar en el popup el estado de un producto ya seguido (precio actual y mínimo)
- [ ] Gestión de suscripciones: «darme de baja de todo» por email
- [ ] Resumen semanal por email (opcional)
- [ ] Versión Firefox de la extensión

## Seguridad / mantenimiento
- [ ] Validar mejor lo que envía la extensión (cualquiera puede llamar a la API): límites por IP más finos, captcha ligero si hay abuso
- [ ] Purga de emails enviados antiguos (`email_queue`)
- [ ] Backups automáticos de la BD
- [ ] CI en GitHub Actions: `npm test` + build de la imagen en cada PR
- [ ] Logs/métricas de la comprobación diaria (cuántos ok / error)
