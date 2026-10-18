# Fraud Service (`fraud-service`)

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
- Puntaje ≥ `FRAUD_REVIEW_THRESHOLD` → alerta `pending` y evento `fraud.alert`.
- Idempotente por `transactionId`: el mismo evento no se califica dos veces.
- Solo roles `compliance` y `admin` ven y resuelven alertas.

**Comunicación con otros servicios**

| | |
|---|---|
| Publica eventos | `fraud.alert` → notification, compliance |
| Consume eventos | `transaction.completed` (ledger) |
| Llama a | — |
| Lo llaman | api-gateway (rutas `/fraud/*`) |
| Integraciones externas | — |

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
| GET | `/health` | Estado del servicio (incluye si la conexión a la base quedó inicializada). |

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

## Pruebas

```bash
npm test
```

## Despliegue

Desplegado en Railway (raíz del servicio: esta carpeta, `railway.json` con
`healthcheckPath: /health`). El servicio no tiene dominio público propio: se accede
por el gateway.

- Estado de todos los servicios (incluye `fraud-service`): https://api-gateway-production-dd7f.up.railway.app/health
- Rutas de este servicio: `https://api-gateway-production-dd7f.up.railway.app/fraud/...`
- Aplicación web: https://frontend-production-eff3c.up.railway.app
