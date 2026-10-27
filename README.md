# Shopify Channel Sync

Auditoría y publicación de productos activos en los canales de Shopify seleccionados por el usuario. React, Express, TypeScript y SQLite; Admin GraphQL API `2026-10`.

## Ejecutar

Usa **Node.js 24 LTS** (`.nvmrc`); también se admite Node 22.14 o posterior de la rama 22. El módulo nativo de SQLite de este proyecto no declara soporte para Node 26.

```sh
nvm install
nvm use
npm ci
npm run dev
```

Abre <http://127.0.0.1:3000>. Para producción:

```sh
npm run build
npm start
```

`npm run preview` inicia el servidor completo de producción, incluida la API. Si cambias de versión de Node después de instalar, ejecuta `npm ci` de nuevo para instalar el binario de SQLite compatible.

## Conectar y operar

1. Introduce el dominio `tienda.myshopify.com` y el token de Admin API. La aplicación de Shopify debe tener `read_products`, `read_publications` y `write_publications`, además de los permisos del usuario requeridos por Shopify.
2. Selecciona los canales y guarda la selección. Solo se incluyen publicaciones de catálogos de aplicaciones (`APP`).
3. Inicia el escaneo. Se recorren todos los resultados paginados, incluidas variantes y publicaciones de cada producto.
4. Revisa los pendientes, los omitidos y los errores. Al finalizar el escaneo, confirma la corrección de los canales seleccionados.
5. Cierra la sesión al terminar.

Los borradores, archivados y productos exclusivos por suscripción se omiten. Las publicaciones programadas para el futuro se respetan. Antes de publicar se vuelve a consultar cada producto; después se verifica la publicación. Un producto ya completo no cuenta como corregido. Los errores se guardan por producto y se reintentan una vez en cada ejecución explícita de corrección.

Se puede detener y reanudar un escaneo desde la última página guardada. Los resultados y el cursor se guardan en la misma transacción. Un nuevo escaneo tras finalizar reemplaza el anterior. Cambiar de tienda o de canales invalida el progreso correspondiente. Reiniciar espera la cancelación de las tareas antes de borrar la auditoría. Una publicación que Shopify ya haya aceptado puede completarse aunque se detenga la solicitud; el siguiente intento consulta el estado actual para reconciliarlo.

## Tokens por sesión

- El token de Shopify se conserva **solo en memoria del servidor**, asociado a un identificador aleatorio de sesión. SQLite guarda únicamente el dominio y los resultados de auditoría.
- El navegador conserva una cookie de sesión `HttpOnly` y `SameSite=Strict`. El token no se devuelve en las respuestas ni se escribe en cookies, `localStorage` o `sessionStorage`. El campo se vacía al enviar la conexión.
- **Cerrar sesión** invalida inmediatamente el identificador, descarta el token y cancela las tareas asociadas.
- Cerrar, navegar o recargar la pestaña envía un aviso de cierre. Si el navegador se bloquea o no entrega ese aviso, el servidor elimina las credenciales tras **2 minutos sin comunicación**, con una comprobación cada 5 segundos.
- La duración máxima de la sesión es **8 horas**, incluso si continúa recibiendo solicitudes. Reiniciar el servidor también descarta las credenciales.
- Se admite una sesión de operación a la vez. Las pestañas del mismo navegador comparten esa sesión; cerrar una la termina para las demás. Para continuar hay que introducir el token nuevamente; la auditoría de la misma tienda puede reanudarse.
- La eliminación es de las referencias de la aplicación; JavaScript no ofrece borrado físico garantizado de RAM. Para invalidar también el token en Shopify, revócalo desde Shopify. Las copias de seguridad anteriores y los tokens guardados por gestores de contraseñas están fuera del control de esta aplicación.

La base antigua se migra sin reutilizar sus auditorías para publicar: los resultados antiguos se archivan y se exige un nuevo escaneo. La columna del token se elimina con `secure_delete`, compactación y limpieza del WAL. No se crean claves de cifrado ni archivos de credenciales de Shopify.

## Configuración

Copia `.env.example` a `.env` solo si necesitas modificar los valores predeterminados. Nunca pongas un token de Shopify en este archivo.

| Variable | Predeterminado | Uso |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interfaz de escucha |
| `PORT` | `3000` | Puerto HTTP |
| `DATABASE_PATH` | `./shopify_sync.db` | Base persistente de auditorías, sin tokens |
| `SHOPIFY_API_VERSION` | `2026-10` | Versión estable de Admin GraphQL |
| `PUBLIC_ORIGIN` | Orígenes locales | URL pública exacta de la aplicación |
| `APP_PASSWORD` | Vacío para uso local | Contraseña adicional de acceso remoto; distinta del token Shopify |

El servidor usa acceso local por defecto. Para exponerlo, configura `HOST=0.0.0.0`, `PUBLIC_ORIGIN=https://...`, una `APP_PASSWORD` de al menos 16 caracteres y un proxy HTTPS. Las cookies son `Secure` en ese modo. Las rutas de API requieren sesión, verifican el origen y el Host, rechazan mutaciones sin JSON y no habilitan CORS abierto. No registres cuerpos de solicitudes ni cookies en el proxy.

Ejecuta **una sola instancia** por base de datos: los trabajos y sesiones viven en memoria. Mantén el archivo SQLite en un volumen persistente y con acceso restringido. El servidor no utiliza webhooks ni una cola distribuida. Los cambios que se hagan simultáneamente en el catálogo de Shopify pueden requerir un nuevo escaneo; la auditoría no es una instantánea transaccional de la tienda.

## Verificación

```sh
npm test
npm run build
```

Las pruebas usan SQLite real y respuestas simuladas de Shopify. Cubren expiración y cierre de sesión, cancelación de operaciones, ausencia de tokens en base y respuestas, migración de credenciales antiguas, exclusión mutua, reanudación, contadores, reintentos, paginación, errores GraphQL/HTTP y verificación de publicaciones. No publican en una tienda real.

Documentación de referencia: [versionado de Shopify](https://shopify.dev/docs/api/usage/versioning), [publicaciones de productos](https://shopify.dev/docs/api/admin-graphql/latest/objects/ResourcePublicationV2) y [publishablePublish](https://shopify.dev/docs/api/admin-graphql/latest/mutations/publishablePublish).
