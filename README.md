# Fraud Service (`fraud-service`)

[![CI](https://github.com/Luisortiz2406/banklite-fraud-service/actions/workflows/ci.yml/badge.svg)](https://github.com/Luisortiz2406/banklite-fraud-service/actions/workflows/ci.yml)

Detección de fraude: califica el riesgo de cada movimiento con reglas y genera alertas para revisión.

Parte de **BankLite**, banco digital académico construido con microservicios. Cada
microservicio tiene su propia base de datos y se comunica con los demás por HTTP
(red interna) o por eventos en RabbitMQ.

## Responsabilidad dentro de la arquitectura

Consume `transaction.completed` y calcula un **puntaje de riesgo** con reglas
configurables. Si supera el umbral, marca el movimiento para revisión y emite
`fraud.alert`. El equipo de cumplimiento revisa y resuelve las alertas desde el panel.

**Reglas de negocio principales**

- Reglas: monto alto, velocidad (muchos movimientos en pocos minutos), salidas del día y fraccionamiento (structuring).
- **Reglas geográficas** de cada inicio de sesión (lo reporta auth-service):
  - **país nuevo**: país que el cliente no usó en 90 días; el primer inicio de sesión no cuenta (20 puntos);
  - **viaje imposible**: el inicio de sesión exitoso anterior fue desde otro país hace menos de 120 min (30);
  - **nodo de salida de Tor** (40).

  Esos puntos se suman a las **salidas de dinero** del cliente durante las 12 h siguientes al inicio de sesión.
- Puntaje ≥ `FRAUD_REVIEW_THRESHOLD` → alerta `pending` y evento `fraud.alert`.
- Idempotente por `transactionId`: el mismo evento no se califica dos veces.
- Solo roles `compliance` y `admin` ven y resuelven alertas, y ven los inicios de sesión de un cliente.

**Geolocalización por IP y privacidad**

- **Base local:** GeoLite2-Country de MaxMind, consultada **dentro del servicio**: la IP no sale de BankLite. La lista pública de nodos de salida de Tor se renueva cada 6 h.
- **Qué se guarda (tabla `login_contexts`):** la red recortada (`/24` en IPv4 o `/48` en IPv6), una huella HMAC-SHA256 con `FRAUD_IP_HASH_SECRET`, el país, si es Tor y las reglas. **La IP completa no se guarda ni aparece en los logs.**
- **Purga diaria** de lo que tenga más de 90 días.
- **Descarga de la base:**
  - se guarda en `fraud_db` (tabla `geo_databases`), porque el disco de Railway no sobrevive a un reinicio: **reiniciar no descarga**;
  - se renueva cada 7 días, con **como mucho un intento cada 24 h**, exitoso o no, aunque el servicio se reinicie (respeta el límite diario de MaxMind);
  - se verifica el SHA256.
- **Si falta algo** (llaves, base, lista de Tor o secreto de huella), el servicio sigue funcionando: `/health` responde `"geo": "degradada"` con los motivos y las reglas de IP no suman puntos.
- Datos de geolocalización: GeoLite2 de MaxMind, https://www.maxmind.com.

**Comunicación con otros servicios**

| | |
|---|---|
| Publica eventos | `fraud.alert` → notification, compliance |
| Consume eventos | `transaction.completed` (ledger) |
| Llama a | — |
| Lo llaman | api-gateway (rutas `/fraud/*`)<br>auth-service: `POST /internal/fraud/logins` (clave interna `auth`)<br>account-service: `GET /internal/fraud/users/:idUser/resumen-cierre` (clave interna `account`) |
| Integraciones externas | MaxMind GeoLite2-Country (descarga semanal de la base) y la lista de nodos de salida de Tor (torproject.org) |

Todo el tráfico externo entra por el **api-gateway** (único servicio público), que
enruta por prefijo (`/fraud`), aplica CORS y límite de peticiones, y bloquea las
rutas internas.

## Tecnologías

- Node.js 20, NestJS 10 y TypeScript
- PostgreSQL con TypeORM (`synchronize: true`: las tablas se crean desde las entidades)
- RabbitMQ (amqplib): exchange `banklite.events`, outbox, reintentos y DLQ
- JWT (`@nestjs/jwt`) y `class-validator` para validar todo lo que entra
- Docker (imagen `node:20-alpine`) y despliegue en Railway

## Base de datos (`fraud_db`)

| Tabla | Contenido |
|---|---|
| `fraud_transaction_log` | Movimientos recibidos (para reglas de velocidad y volumen). |
| `risk_scores` | Puntaje y reglas disparadas por movimiento. |
| `flagged_transactions` | Alertas y su resolución. |
| `fraud_outbox` | Outbox de `fraud.alert`. |
| `admin_audit` | Bitácora de acciones del panel en este servicio (quién, rol, qué y cuándo). |
| `login_contexts` | Inicios de sesión: red recortada, huella HMAC, país, Tor y reglas (sin la IP completa; purga a los 90 días). |
| `geo_databases` | Copia de la base GeoLite2-Country y hora del último intento de descarga. |

En `database/`:

| Archivo | Qué es |
|---|---|
| `schema.sql` | Esquema (tablas, índices, restricciones), generado con `pg_dump --schema-only` desde la base que crea TypeORM. |
| `seed.sql` | Datos de ejemplo de un escenario de demo compartido por todos los servicios (clientes ficticios Ana y Carlos, con los mismos UUID en todas las bases). |
| `backup.sql` | Respaldo completo (esquema + datos de ejemplo) listo para restaurar. |

Restaurar en una base vacía:

```bash
createdb fraud_db
psql "postgres://usuario:clave@localhost:5432/fraud_db" -f database/backup.sql
# o, por partes:
psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
```

Si se arranca el servicio con una base vacía, TypeORM crea las tablas solo.

## Instalación y ejecución

Requisitos: Node.js 20, PostgreSQL 16, RabbitMQ 3.

```bash
npm ci
cp .env.example .env     # completa los secretos (ver abajo)
npm run start:dev        # desarrollo, recarga al guardar
# producción:
npm run build && npm run start:prod
```

Con Docker:

```bash
docker build -t banklite-fraud-service .
docker run --env-file .env -p 3009:3009 banklite-fraud-service
```

El sistema completo (los 12 servicios, Postgres, RabbitMQ y el gateway) se levanta
desde el repositorio principal con `docker compose up -d --build`.

Comprobar: `curl http://localhost:3009/health`

## Endpoints principales

A través del gateway las rutas son las mismas (`http://localhost:8080/fraud/...`).

### Públicos (sin sesión)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado del servicio y de su base (`SELECT 1`); responde 503 con `status: down` si la base no contesta. Además `geo`: `ok` o `degradada` (con `motivos`), sin cambiar el `status`. |

### Internos (solo red privada, `x-internal-key`; el gateway responde 404 desde afuera)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/internal/fraud/logins` | `{idUser, sessionId?, ip, outcome, occurredAt?}`: inicio de sesión que reporta **solo auth-service**. Responde 202 con `{stored}`. |
| GET | `/internal/fraud/users/:idUser/resumen-cierre` | Solo **account-service** («Cancelar mi cuenta»): `{alertasAbiertas, sinPendientes}`. Solo el número de alertas `pending`, nunca su detalle. |

### Panel administrativo (`Authorization: Bearer <token de empleado>`; el gateway además valida la sesión)

| Método | Ruta | Roles | Descripción |
|---|---|---|---|
| GET | `/fraud/admin/flags` | compliance, admin | Alertas de fraude. |
| GET | `/fraud/admin/flags/:id` | compliance, admin | Detalle de una alerta. |
| PATCH | `/fraud/admin/flags/:id` | compliance, admin | Resuelve una alerta (descartada / confirmada). |
| GET | `/fraud/admin/audit` | cualquier empleado | Bitácora de acciones del panel en este servicio (quién, rol, qué y cuándo). |
| GET | `/fraud/admin/dlq` | cualquier empleado | Mensajes en la cola de errores (DLQ). |
| GET | `/fraud/admin/dlq/messages` | cualquier empleado | Contenido de los mensajes de la DLQ. |
| POST | `/fraud/admin/dlq/requeue` | admin | Reencola mensajes de la DLQ (solo administradores). |
| GET | `/fraud/admin/users/:idUser/logins` | compliance, admin | Inicios de sesión recientes del cliente: país, red recortada, Tor y reglas (nunca la IP ni su huella). Queda en la bitácora. |

## Variables de entorno

Ver `.env.example`. Los secretos se generan con
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (uno distinto
por variable). El servicio **no arranca** si un secreto falta, es corto, es un valor de
ejemplo o se repite entre dos variables (`src/config/env.validation.ts`). En Railway
todas se configuran como variables del servicio, nunca en el código.

| Variable | Obligatoria | Ejemplo / por defecto | Para qué sirve |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `development` en local; `production` en Railway (lo fija el Dockerfile). |
| `PORT` | No | `3009` | Puerto HTTP del servicio. |
| `DATABASE_URL` | **Sí** (no arranca sin ella) | `postgres://fraud_svc:<DB_PASSWORD_FRAUD>@localhost:5432/fraud_db` | Conexión a PostgreSQL de **su** base (rol propio, sin acceso a las demás). |
| `STAFF_JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de empleados del panel (el mismo que en auth-service; distinto de JWT_SECRET). |
| `RABBITMQ_URL` | No | `amqp://banklite:banklite@localhost:5672` | Conexión a RabbitMQ. Sin ella los eventos quedan en el outbox (o no se consumen). |
| `FRAUD_HIGH_AMOUNT_THRESHOLD` | No | `20000000` | Regla «monto alto»: desde este valor suma riesgo. |
| `FRAUD_VELOCITY_MAX_TX` | No | `5` | Regla «velocidad»: máximo de movimientos en la ventana. |
| `FRAUD_VELOCITY_WINDOW_MIN` | No | `10` | Ventana (minutos) de la regla de velocidad. |
| `FRAUD_DAILY_OUTFLOW_THRESHOLD` | No | `30000000` | Regla «salidas del día»: tope diario de salidas. |
| `FRAUD_REVIEW_THRESHOLD` | No | `60` | Puntaje desde el que el movimiento queda en revisión y se emite `fraud.alert`. |
| `RABBITMQ_EXCHANGE` | No | `banklite.events` | Exchange topic de eventos (`banklite.events`). |
| `RABBITMQ_QUEUE` | No | `fraud-service.transaction-completed` | Cola propia del servicio (con `<cola>.retry` y `<cola>.dlq`). |
| `EVENT_MAX_RETRIES` | No | `5` | Reintentos de un evento antes de mandarlo a la DLQ. |
| `EVENT_RETRY_DELAY_MS` | No | `10000` | Espera entre reintentos de un evento. |
| `INTERNAL_TRUSTED_KEYS` | Para las rutas internas | `auth:<clave-de-auth>,account:<clave-de-account>` | `auth` reporta inicios de sesión y `account` pide el resumen de cierre; cada uno solo a lo suyo (403 si no). Sin ella se rechaza todo. |
| `MAXMIND_ACCOUNT_ID` | Para la geolocalización | — | Número de cuenta de MaxMind (no es secreto). |
| `MAXMIND_LICENSE_KEY` | Para la geolocalización | — | Llave de licencia de MaxMind (secreta) para descargar GeoLite2. |
| `FRAUD_IP_HASH_SECRET` | Para guardar inicios de sesión | — | Secreto de la huella HMAC de la IP (32+ caracteres aleatorios). Sin él no se guarda ningún inicio de sesión; si es débil, el servicio no arranca. |
| `FRAUD_GEO_NEW_COUNTRY_POINTS` | No | `20` | Puntos de «país nuevo». |
| `FRAUD_GEO_IMPOSSIBLE_TRAVEL_POINTS` | No | `30` | Puntos de «viaje imposible». |
| `FRAUD_GEO_TOR_POINTS` | No | `40` | Puntos de «nodo de salida de Tor». |
| `FRAUD_GEO_TRAVEL_WINDOW_MIN` | No | `120` | Dos países distintos en menos de estos minutos = viaje imposible. |
| `FRAUD_GEO_SESSION_HOURS` | No | `12` | Horas después de un inicio de sesión en que sus reglas cuentan para las transacciones. |
| `FRAUD_GEO_RETENTION_DAYS` | No | `90` | Historial para «país nuevo» y retención de los inicios de sesión (purga diaria). |

## Pruebas

```bash
npm test   # con TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres para las de base
```

- Reglas geográficas (incluidos los límites de 119 y 121 min), recorte de prefijos y huella.
- Descarga de GeoLite2: SHA256, copia guardada (reiniciar no descarga), un intento cada 24 h y modo degradado.
- Contextos sin la IP completa, purga a 90 días y suma de puntos a las transferencias.
- Permisos del endpoint interno (solo `auth`) y del panel (solo `compliance` y `admin`).

`test/fixtures/GeoIP2-Country-Test.mmdb` es la base de prueba de MaxMind ([MaxMind-DB](https://github.com/maxmind/MaxMind-DB), licencia MIT/Apache-2.0); no tiene datos reales.

## Despliegue

Desplegado en Railway **desde este repositorio** (rama `main`): `railway.json` en la
raíz define el build por `Dockerfile` y el health check en `/health`; cada push a
`main` redespliega el servicio. El servicio no tiene dominio público propio: se accede
por el gateway.

- Estado del servicio y de su base: [https://api-gateway-production-dd7f.up.railway.app/health](https://api-gateway-production-dd7f.up.railway.app/health) (entrada `fraud-service`: `status` y `database` deben estar en `ok`)
- Rutas de este servicio: `https://api-gateway-production-dd7f.up.railway.app/fraud/...`
- Aplicación web: https://frontend-production-eff3c.up.railway.app

## Repositorios relacionados

Servicios de BankLite con los que se comunica este. **Llama a** / **Lo llama**: HTTP
por la red interna; **Recibe** / **Envía**: eventos en RabbitMQ. Cada uno vive y se
despliega desde su propio repositorio.

| Repositorio | Relación con este servicio |
|---|---|
| [banklite-api-gateway](https://github.com/Luisortiz2406/banklite-api-gateway) | **Lo llama:** punto de entrada público, le enruta las rutas de este servicio |
| [banklite-account-service](https://github.com/Luisortiz2406/banklite-account-service) | **Lo llama:** resumen de alertas abiertas para cancelar la cuenta |
| [banklite-auth-service](https://github.com/Luisortiz2406/banklite-auth-service) | **Lo llama:** reporta cada inicio de sesión con la IP del cliente (`POST /internal/fraud/logins`) |
| [banklite-ledger-service](https://github.com/Luisortiz2406/banklite-ledger-service) | **Recibe:** `transaction.completed` (se evalúa con las reglas de riesgo) |
| [banklite-notification-service](https://github.com/Luisortiz2406/banklite-notification-service) | **Envía:** `fraud.alert` |
| [banklite-compliance-service](https://github.com/Luisortiz2406/banklite-compliance-service) | **Envía:** `fraud.alert` |
