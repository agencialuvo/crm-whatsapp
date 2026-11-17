# 045 — Super Admin: planes SaaS, membresías y dashboard de control

**Feature Branch**: `feat/045-super-admin-membresias`

**Created**: 2026-11-17

**Status**: **Implementada** (2026-11-17), con las ocho preguntas de revisión aprobadas tal como se propusieron (Q1 Demo con todo, Q2 2FA obligatorio, Q3 prueba vencida → `past_due`/`trial_ended`, Q4 sin pausar agente ni automatizaciones, Q5 retirar Básico/Salón, Q6 los tres planes de pago con sus límites declarados, Q7 la activación manual cuenta como conversión marcada `admin`, Q8 Super Admin sin organización). Pendiente de commit. Verificada contra Postgres real (`super-admin-live`, 14 pruebas) y de punta a punta con la app y el mock (`pnpm test:e2e:super-admin`); **no con volumen real de producción**.

Ajustes que salieron al implementar (respecto del texto de abajo):
- **La hora de un cambio se toma DESPUÉS del candado de fila.** La prueba de dos acciones simultáneas lo cazó: con la hora tomada antes de esperar el candado, la segunda acción podía quedar «antes» que la primera en la historia.
- **`chooseSector` dejó de reasignar el plan de una prueba**, salvo si el plan actual es uno ANTERIOR (Básico/Salón, que se elegían por el sector). Lo encontró la prueba de vigilancia («solo la puerta escribe la suscripción»): ahora lo hace `reassignTrialPlan` en la puerta, con evento `plan_changed` (`source = system`, `reason = sector_changed`). Con la Demo incluyendo todo, el sector ya no decide el plan.
- **El alta con el respaldo** (catálogo sin Demo) también pasa por la puerta (`startFallbackSubscription`) y su evento queda **aproximado**: no cuenta como prueba de conversión.
- **El filtro «Prueba vencida» incluye la derivada y la persistida** (`past_due` por `trial_ended`); «Pago vencido» es el `past_due` que no viene de una prueba (`matchesStatusFilter`, pura).
- **`extend_trial` valida primero que la acción quepa en el estado (409) y después los días (422).**
- **Las organizaciones de un plan anterior que un Super Admin suspende o cancela SÍ se bloquean** con `SAAS_ENFORCE` (lo explícito manda); lo que nunca se bloquea es una organización sin suscripción o con un plan anterior vigente (esos planes no vencen solos).
- **Rutas de la cuenta (`withAccountAuth`)** quedan fuera del corte por suscripción: una persona con la suscripción vencida sigue pudiendo cuidar su contraseña y su segundo factor.
- **Un Super Admin sin organización** que aún no tiene 2FA no puede activarlo desde la app (las rutas de la cuenta exigen organización): el comando `pnpm superadmin grant` avisa y la guía pide activarlo ANTES de conceder.
- **El E2E enciende `two_factor_enabled` por SQL** después de iniciar sesión (con el 2FA activo el inicio de sesión pide un código del correo que un guion no puede leer).

**Input**: Paso 1 del panel de Superadministrador: arquitectura de acceso, los 4 planes, trial de 14 días automático, dashboard de métricas con conversión Demo → pago y directorio de organizaciones con control manual (antes de conectar Mercado Pago, que será el paso 2).

**Carril**: ciclo completo (Principio VI). Añade **una migración** (0080: bandera en `user`, columnas en `plan` y `subscription`, y dos tablas de bitácora), **un módulo cross-tenant deliberado** (`src/server/super-admin/`, la única excepción controlada a `scoped()`), **una superficie nueva** (`/super-admin` y `/api/super-admin/*`) y **cambia el alta de organizaciones** (Demo de 14 días en vez de «el plan más barato que cubre el sector»). Sin bandera de despliegue para el panel (solo existe para quien tiene la bandera `is_super_admin`); el **bloqueo por suscripción vencida** va detrás de `SAAS_ENFORCE`, apagado por defecto.

## Decisiones ya tomadas en el encargo

1. Un Super Admin se identifica con una columna **`user.is_super_admin`** (o equivalente seguro) y las rutas `/super-admin` y `/api/super-admin/*` quedan aisladas de los tenants.
2. Cuatro planes: **Demo** (14 días, `trialing`), **Emprendedor** (S/ 79/mes), **Pro** (S/ 149/mes), **Enterprise** (S/ 299/mes, ilimitado).
3. Toda organización nueva nace con una suscripción `trialing` de 14 días.
4. Dashboard con totales por estado, desglose por plan, **conversión Demo → pago** y **MRR** estimado; directorio con acciones manuales (cambiar plan, activar/suspender, extender prueba).

## Cómo está hoy (leído del código)

- **Tablas.** `plan` (`name`, `slug` único, `price_monthly_cents`, `features` jsonb con `maxStaff`, `maxMonthlyAiTurns`, `channels`, `modules`, `active`) y `subscription` (**única por organización**, `plan_id`, `status` ∈ `trialing|active|past_due|canceled|paused`, `current_period_start/end`, `cancel_at_period_end`). Prefijos `plan` y `sub` ya existen en `ids.ts`.
- **Planes sembrados hoy:** «Básico» y «Salón», ambos a **precio 0** (`src/server/seed/platform-catalog.ts`, `ON CONFLICT DO NOTHING` por `slug`, al arrancar y con `pnpm seed:platform`). **No existen** Emprendedor, Pro ni Enterprise.
- **Alta de organización** (`src/server/auth/on-signup.ts`, `seedOrganization`): crea la suscripción `trialing` con **30 días** sobre el plan que devuelve `pickInitialPlan` (el más barato que cubre los módulos del sector). Lo llaman el primer dueño de la instancia (`onUserCreated`) y el registro público (`onOwnerRegistered`, `ALLOW_SIGNUP=true`).
- **Nada hace cumplir el estado de la suscripción.** `getPlanAccess` (`saas-guard.ts`) solo mira los **módulos** del plan: un `trialing` con el periodo vencido, un `past_due`, un `paused` o un `canceled` siguen con acceso completo. Nada actualiza `status` (no hay temporizador ni UI de control). Las organizaciones **sin suscripción** (anteriores al módulo SaaS) tienen acceso completo a propósito. Los límites `maxStaff` y `maxMonthlyAiTurns` **no se aplican en ninguna parte** (solo se declaran).
- **No hay historia.** Con la fila actual de `subscription` no se puede saber cuántas pruebas empezaron ni cuántas se convirtieron: un `canceled` de hoy no recuerda que fue `active`. La conversión exige una bitácora (mismo argumento que `lead_stage_event` en el pipeline).
- **Identidad y sesión.** Better Auth (`user` sin rol de plataforma; el rol vive en `member.role` por organización). `requireSession()` **exige membresía**: un usuario sin organización recibe `UnauthorizedError`. No existe middleware: cada página y cada ruta se protege a sí misma (`withAuth`, layout de `(app)`). Existe 2FA por correo (`user.two_factor_enabled`) y limitador de intentos en login.
- **Tablas de UI.** La regla del sistema es `useDataTable` + `DataTableToolbar` + `DataTablePagination` (paginación en el cliente sobre una lista ya filtrada), `SearchSelect` para desplegables, `DatePicker` para fechas y una X en cada ventana.
- **Una cuenta por backend.** Las cuentas se crean con `pnpm crear-usuario` / `pnpm e2e:cuentas` (esbuild + alias `@`); ese patrón sirve para el CLI del Super Admin.

## Diseño

### 1. Acceso y seguridad

- **`user.is_super_admin boolean not null default false`.** Better Auth no declara el campo (`additionalFields`), así que **no se puede escribir** por ninguna de sus rutas (alta, actualización de perfil): no hay forma de auto-promoverse por HTTP. Una prueba de vigilancia lo fija.
- **Se concede solo por backend:** `pnpm superadmin grant|revoke|list <correo>` (`scripts/superadmin.ts`, mismo patrón que `crear-usuario`). Sin pantalla para otorgarlo. Cada concesión/revocación escribe una fila en `super_admin_audit` (`action: grant|revoke`, `actor` = `null` porque lo hace el operador del servidor).
- **`requireSuperAdmin()`** (`src/lib/auth/super-admin.ts`): toma la sesión de Better Auth **sin exigir membresía** (el Super Admin puede no pertenecer a ninguna organización) y **lee `is_super_admin` de la base en cada petición** —nunca de la cookie ni de la sesión—, así revocar surte efecto al instante.
  - **Páginas** (`/super-admin/**`): sin sesión → `/iniciar-sesion`; con sesión pero sin la bandera → **`notFound()`** (el panel no revela su existencia).
  - **API** (`/api/super-admin/**`): sin sesión → 401; con sesión pero sin la bandera → **404** (mismo motivo). Todo handler va envuelto en **`withSuperAdmin`** (paralelo de `withAuth`); una prueba de vigilancia falla si una ruta bajo `api/super-admin/` no lo usa.
- **2FA obligatorio para el Super Admin** (Q2): si `two_factor_enabled` es `false`, el panel responde 403 `two_factor_required` con la explicación y el enlace a Mi perfil. Un Super Admin sin segundo factor es el eslabón más débil de toda la plataforma.
- **Mutaciones:** exigen `Origin` igual a `APP_BASE_URL` (defensa CSRF adicional a la cookie `SameSite`), validan con Zod, y están limitadas por `checkRateLimit` (30 por minuto por usuario).
- **Aislamiento y minimización de datos.** El panel es **cross-tenant por diseño** y por eso vive en un módulo propio, `src/server/super-admin/`, la **única** excepción a `scoped()`. Reglas: (a) una prueba de vigilancia falla si cualquier archivo fuera de `src/server/super-admin/**` y `src/app/api/super-admin/**` importa ese módulo; (b) el panel **solo ve metadatos de la cuenta** —nombre de la organización, dueño (nombre y correo), plan, estado, fechas y conteos agregados—, **nunca** conversaciones, contactos, mensajes, credenciales, tokens ni llaves; (c) una prueba recorre los DTO y falla si aparece un campo fuera de la lista permitida.
- **Todo cambio manual deja rastro**: fila en `super_admin_audit` (quién, qué, a qué organización, antes/después, motivo, IP) **y** en `subscription_event` (la historia de la suscripción), en la **misma transacción** que el cambio.

### 2. Planes (catálogo)

Se añaden columnas a `plan`: `trial_days integer null` (≥ 0; un plan con `trial_days` es de prueba), `currency text not null default 'PEN'` y `sort_order integer not null default 0`. El catálogo vive en `src/server/seed/platform-catalog.ts` (idempotente, por `slug`):

| Plan | `slug` | Precio (centavos, PEN) | Prueba | Módulos | Canales | Límites declarados |
|---|---|---|---|---|---|---|
| **Demo** | `demo` | 0 | **14 días** | agenda, salon, loyalty, finances, atribucion (**todo**, Q1) | whatsapp, instagram, messenger | 3 profesionales · 1 000 turnos de IA |
| **Emprendedor** | `emprendedor` | **7 900** | — | agenda, salon, loyalty | whatsapp | 3 profesionales · 1 000 turnos |
| **Pro** | `pro` | **14 900** | — | agenda, salon, loyalty, finances, atribucion | whatsapp, instagram, messenger | 10 profesionales · 5 000 turnos |
| **Enterprise** | `enterprise` | **29 900** | — | todos | todos | ilimitado (`-1`) |

- **Los dos planes actuales** («Básico» y «Salón») se **retiran** (`active = false`) con un `UPDATE` de la migración: las organizaciones que ya los tienen **conservan su acceso** (`getPlanAccess` no mira `active`) y se muestran en el directorio como «Plan anterior». Dejan de sembrarse en instalaciones nuevas.
- **Los precios viven en el código** (no se editan desde el panel en este paso; `ON CONFLICT DO NOTHING` no pisa un ajuste manual de la base). Editar planes desde el panel queda fuera de alcance.
- Los límites (`maxStaff`, `maxMonthlyAiTurns`) **siguen sin aplicarse**: hoy solo son datos del plan. Hacerlos cumplir es un paso posterior.

### 3. Alta de organización = Demo de 14 días

`seedOrganization` (usado por `onUserCreated` y `onOwnerRegistered`) deja de usar `pickInitialPlan` y asigna **el plan `demo`**: `status = 'trialing'`, `current_period_start = ahora`, `current_period_end = ahora + 14 días`, `trial_started_at = ahora`, y escribe el evento `trial_started` (`source = 'signup'`). Si el plan `demo` no existe (catálogo sin sembrar), **cae al comportamiento anterior** (`pickInitialPlan`), para no dejar a nadie sin suscripción. `pickInitialPlan` y su prueba se conservan.

### 4. Máquina de estados y reglas de negocio (puras)

Todo en `src/lib/saas.ts` (sin base de datos ni red, probable con tablas de casos):

- **Estado efectivo** `effectiveStatus(sub, plan, now)`: `trialing` con periodo vigente → `trialing`; **`trialing` de un plan de prueba con el periodo vencido** → `trial_expired` (derivado: el temporizador lo persistirá como `past_due`); el resto, tal cual. `daysLeft` para pruebas.
- **Transiciones permitidas** (`decideTransition({ action, from, plan, … })`; lo no permitido responde 409 `invalid_transition`):

| Acción | Desde | Hacia | Notas |
|---|---|---|---|
| `assign` | sin suscripción | `trialing` o `active` | Para organizaciones anteriores al módulo SaaS. |
| `activate` | `trialing`, `past_due`, `paused`, `canceled` | `active` | Exige un **plan de pago**; periodo `ahora → +30 días`. Desde `trialing` cuenta como **conversión**. |
| `change_plan` | cualquiera | mismo estado | Solo cambia `plan_id` (activa o en prueba). |
| `extend_trial` | `trialing`, `past_due` por prueba vencida | `trialing` | Suma 1–90 días desde el fin actual (o desde hoy si ya venció). Solo planes de prueba. |
| `set_period_end` | `trialing`, `active` | igual | Fecha exacta del corte. |
| `suspend` | `trialing`, `active`, `past_due` | `paused` | |
| `cancel` | cualquiera salvo `canceled` | `canceled` | Con opción «al final del periodo» (`cancel_at_period_end`). |
| `reactivate` | `paused`, `canceled` | `active` | Equivale a `activate`; se registra como reactivación, no como conversión. |

- **Toda acción exige un motivo** (texto corto, 3–300 caracteres) y confirmación en pantalla.
- **Vencimiento automático.** Un temporizador (`subscription-sweeper.ts`, cada hora, arrancado en `instrumentation-node.ts` como el `outbox-sweeper`) pasa a **`past_due`** toda suscripción `trialing` **de un plan de prueba** cuyo periodo venció (`status_reason = 'trial_ended'`, evento `expired`). Idempotente y por tandas. **No toca** las suscripciones de planes anteriores (Básico/Salón): hoy no vencen y siguen sin vencer.

### 5. Bitácora, conversión y MRR

**`subscription_event`** (append-only, prefijo `sev`): `organization_id`, `type` ∈ `trial_started | converted | reactivated | plan_changed | status_changed | trial_extended | period_changed | expired | assigned`, `from_status`/`to_status`, `from_plan_id`/`to_plan_id` **y sus nombres** (snapshots: sobreviven a que un plan se retire), `period_end_before/after`, `source` ∈ `signup | admin | system | payment` (`payment` lo usará Mercado Pago en el paso 2), `actor_user_id`, `reason`, `approximate`, `occurred_at`. Índices `(organization_id, occurred_at)` y `(type, occurred_at)`. Mismo principio que `lead_stage_event`: la única puerta que escribe `subscription.status/plan_id/periodos` es `src/server/saas/subscription.ts`; una prueba de vigilancia escanea `src/` y falla si otro archivo lo hace.

**Relleno de la migración:** para cada suscripción existente se inserta un `trial_started` con `approximate = true` (fecha de creación). Las filas aproximadas **no entran** en el cálculo de conversión (serían pruebas inventadas: hoy ninguna vence ni se cobra).

**Definiciones** (todas calculadas por `computeMetrics`, pura, sobre filas ya leídas):
- **Totales:** organizaciones registradas; y por estado efectivo `active`, `trialing` (vigentes), `past_due` (incluye las pruebas vencidas derivadas y las ya persistidas), `canceled`, `paused`, y **«sin suscripción» (anteriores)** como grupo aparte para que la suma cuadre con el total.
- **Por plan:** matriz plan × estado; los planes retirados salen juntos como «Planes anteriores».
- **Conversión Demo → pago** (sobre eventos no aproximados): `iniciaron` = organizaciones con `trial_started`; `convirtieron` = con `converted`; **`tasa cerrada = convirtieron / (convirtieron + pruebas vencidas o canceladas sin convertir)`** (las pruebas todavía en curso **no** deprimen la tasa) y `tasa total = convirtieron / iniciaron`. Además: pruebas en curso, vencidas sin convertir y **días medianos hasta convertir**. Con corte por mes de inicio (últimos 6) y total histórico. Las activaciones manuales cuentan como conversión pero quedan marcadas `source = admin` (cuando llegue Mercado Pago se podrán separar pagos reales de cortesías).
- **MRR:** suma de `price_monthly_cents` de las suscripciones **`active`** (en PEN; un plan con otra moneda no se suma y se avisa). Aparte, **MRR en salida** (`active` con `cancel_at_period_end`) y **ingreso en riesgo** (`past_due` de planes de pago). ARR = MRR × 12; ARPA = MRR / activas.
- **Altas por día** de los últimos 30 días (sparkline).

### 6. API (`/api/super-admin/*`, todo con `withSuperAdmin`)

| Ruta | Qué hace |
|---|---|
| `GET /metrics` | El dashboard completo (totales, plan × estado, conversión, MRR, altas). Una sola respuesta, con `computedAt`. |
| `GET /organizations?q&plan&status&limit` | Directorio: `id`, nombre, **dueño** (nombre, correo), plan, estado efectivo, `daysLeft`, `currentPeriodEnd`, `cancelAtPeriodEnd`, `createdAt`. Búsqueda por nombre de organización o correo/nombre del dueño. Tope de 5 000 filas (la tabla pagina en el cliente con `useDataTable`). |
| `GET /organizations/[id]` | Detalle: lo anterior + historia (`subscription_event`) y registro de auditoría de esa organización. |
| `POST /organizations/[id]/subscription` | `{ action, planId?, days?, periodEnd?, cancelAtPeriodEnd?, reason }` con las acciones de la tabla de transiciones. Transaccional: cambia la suscripción, escribe el evento y la auditoría. 409 si la transición no es válida, 422 si falta el motivo. |
| `GET /plans` | Los planes activos (para el selector) con precio y módulos. |

### 7. Interfaz (`/super-admin`, fuera del grupo `(app)`)

- **Layout propio** (`src/app/super-admin/layout.tsx`), sin `AppShell` ni contexto de organización: cabecera con el nombre del operador y enlace «Volver a la app» (solo si tiene organización). Gate: `requireSuperAdminPage()`.
- **Dashboard** (arriba): tarjetas Organizaciones, Activas, En prueba, Vencidas, Canceladas, MRR; desglose por plan (barras); tarjeta de **conversión Demo → pago** (tasa cerrada, iniciaron/convirtieron/en curso/vencidas, mediana de días, últimos 6 meses); altas de 30 días.
- **Directorio** (debajo): `DataTableToolbar` + `useDataTable` (vista `super-admin-organizaciones`), filtros con `SearchSelect` (plan, estado) y búsqueda; columnas Organización · Dueño/correo · Plan · Estado (insignia) · Días de prueba / corte · Alta · Acciones.
- **Acciones rápidas** por fila (menú) y **cajón de detalle** con la historia: Cambiar plan (`SearchSelect`), Activar, Suspender, Cancelar, Reactivar, Extender prueba (días), Fijar fecha de corte (`DatePicker`). Cada una abre una ventana con **X y cierre al tocar fuera**, pide el **motivo** y confirma; tras guardar, la fila y el dashboard se actualizan.
- Estados vacíos y de error con `EmptyState`; sin la bandera → 404 (nunca un «no autorizado» que confirme que el panel existe).

### 8. Cumplimiento de la suscripción (`SAAS_ENFORCE`, apagado por defecto)

Hoy el estado no se cumple, y activarlo de golpe **bloquearía a las instalaciones propias y a los clientes existentes**. Por eso el bloqueo va detrás de una bandera de despliegue (patrón ADR-001), **apagada por defecto**:
- Con `SAAS_ENFORCE=true`, una organización cuyo estado efectivo sea `trial_expired`, `past_due`, `canceled` o `paused` ve la página **`/suscripcion-inactiva`** (en vez de `(app)`), y la API del tenant responde 403 `SUBSCRIPTION_INACTIVE` (salvo `auth`, `account`, `health` y los webhooks, que **siguen ingiriendo mensajes**: no se pierde nada del cliente por una prueba vencida).
- Con la bandera apagada, solo se **muestra** un aviso («Tu prueba termina en N días» / «terminó») en el layout y el estado queda visible en el panel.
- Las organizaciones **sin suscripción** y las de **planes anteriores** nunca se bloquean.
- El agente de IA y las automatizaciones **no se pausan** en este paso (Q4).

## Migración 0080

- `user.is_super_admin boolean not null default false`.
- `plan.trial_days integer null check (>= 0)`, `plan.currency text not null default 'PEN'`, `plan.sort_order integer not null default 0`.
- `subscription.trial_started_at timestamp null`, `converted_at timestamp null`, `status_reason text null`, `status_changed_at timestamp null`.
- Tablas **`subscription_event`** y **`super_admin_audit`** (ver §5 y §1; `super_admin_audit.target_organization_id` sin cascada, con el **nombre** de la organización en una columna, para que la auditoría sobreviva a que se elimine).
- `UPDATE plan SET active = false WHERE slug IN ('basico', 'salon')`.
- Relleno de eventos `trial_started` aproximados.
- Los 4 planes **no** se insertan en la migración: los siembra `seedPlatformCatalog` al arrancar (el mecanismo de hoy). `ids.ts`: `subscriptionEvent: "sev"`, `superAdminAudit: "saa"`.

## Plan por archivo

**Base de datos**
- `src/lib/db/schema.ts`: columnas nuevas y las dos tablas; `src/lib/db/ids.ts`; `drizzle/0080_*.sql` + snapshot (SQL de relleno a mano).

**Núcleo puro**
- `src/lib/saas.ts` (nuevo): `effectiveStatus`, `decideTransition`, `computeMetrics`, `computeConversion`, `mrrCents`, etiquetas y colores de insignia.
- `src/lib/super-admin.ts` (nuevo): Zod de las acciones, DTO del directorio y del dashboard, lista blanca de campos.

**Servidor**
- `src/server/saas/subscription.ts` (nuevo): **la única puerta** que escribe `subscription`: `applySubscriptionAction` (transaccional: estado + evento), `startTrial`. `src/server/saas/subscription-sweeper.ts`: vencimiento horario.
- `src/server/saas/enforcement.ts` (nuevo): `getSubscriptionAccess`, `subscriptionInactive` (respeta `SAAS_ENFORCE`).
- `src/server/super-admin/{metrics,directory,actions,audit}.ts` (nuevos): consultas cross-tenant (la excepción documentada a `scoped()`).
- `src/lib/auth/super-admin.ts` (nuevo): `requireSuperAdmin`, `getSuperAdminOrNull`, `withSuperAdmin`, `requireSuperAdminPage`.
- `src/server/auth/on-signup.ts`: `seedOrganization` asigna Demo (con `startTrial`) y cae a `pickInitialPlan` si falta.
- `src/server/seed/platform-catalog.ts`: los 4 planes; retira Básico/Salón del catálogo base.
- `src/instrumentation-node.ts`: arranca el temporizador. `src/lib/env.ts` y `.env.example`: `SAAS_ENFORCE`.
- `src/app/(app)/layout.tsx`: aviso de prueba y, con la bandera, redirección a `/suscripcion-inactiva`; `src/app/page.tsx`: un Super Admin **sin organización** entra directo a `/super-admin`.
- `scripts/superadmin.ts` (nuevo) y script `superadmin` en `package.json`; `scripts/e2e-cuentas.ts`: crea también un Super Admin de prueba (`automations-sa@vocero.test`, sin organización).

**API y páginas**
- `src/app/api/super-admin/{metrics,plans,organizations,organizations/[id],organizations/[id]/subscription}/route.ts`.
- `src/app/super-admin/{layout,page}.tsx`; `src/app/suscripcion-inactiva/page.tsx`.

**UI** (`src/components/super-admin/`): `metric-cards.tsx`, `plan-breakdown.tsx`, `conversion-card.tsx`, `organizations-table.tsx`, `subscription-dialog.tsx` (las 7 acciones), `organization-drawer.tsx`; `src/components/avisos/aviso-suscripcion.tsx`.

**Docs:** `CLAUDE.md` (fila del mapa), `AGENTS.md`, `CHANGELOG.md` (incluye el cambio de plan inicial y el aviso de `SAAS_ENFORCE`), este `spec.md`, `.env.example` y una guía corta [docs/super-admin.md](../../docs/super-admin.md) (cómo otorgar la bandera y qué ve el panel).

## Plan de pruebas

**Unitarias (puras)**
- `tests/unit/saas.test.ts`: `effectiveStatus` (prueba vigente/vencida, plan de pago, plan anterior); **tabla completa de `decideTransition`** (cada acción × cada estado: permitida o 409; `activate` exige plan de pago; `extend_trial` solo en planes de prueba); `mrrCents` (solo `active`, otra moneda avisada); `computeConversion` (tasa cerrada vs total, en curso fuera de la tasa cerrada, aproximadas excluidas, mediana de días, cohortes por mes); `computeMetrics` con la suma de estados **igual al total** (incluido «sin suscripción»).
- `tests/unit/super-admin-contracts.test.ts`: Zod (motivo obligatorio, días 1–90, plan de pago al activar), y que ningún DTO contenga campos fuera de la lista blanca (sin teléfonos de contactos, credenciales ni mensajes).
- `tests/unit/super-admin-guard.test.ts` (vigilancia): toda ruta bajo `api/super-admin/` usa `withSuperAdmin`; nadie fuera de `src/server/super-admin/**` y `src/app/api/super-admin/**` importa ese módulo; `is_super_admin` **no** está en los `additionalFields` de Better Auth; solo `server/saas/subscription.ts` escribe `subscription.status/planId/currentPeriodEnd`.
- `tests/unit/platform-catalog.test.ts` y `pipeline-seed`-style: los 4 planes (precios 7900/14900/29900, Demo con `trialDays: 14`, Enterprise ilimitado) y Básico/Salón fuera del catálogo base.

**Contra Postgres real** (`tests/unit/super-admin-live.test.ts`, con `RUN_DB_TESTS=1`; crea organizaciones temporales)
1. **Alta = Demo de 14 días:** `onOwnerRegistered` deja `trialing`, `period_end ≈ +14 d`, `trial_started_at`, plan `demo` y un evento `trial_started`; sin catálogo, cae a `pickInitialPlan`.
2. **Acciones de punta a punta** (cada una con su evento y su auditoría **en la misma transacción**; un fallo a medias no deja el cambio sin rastro): cambiar plan, activar (conversión: `converted_at` y evento `converted`), suspender, cancelar (también «al final del periodo»), reactivar, extender prueba, fijar corte. Transición inválida → 409 y **nada escrito**.
3. **Métricas contra datos sembrados:** totales, matriz plan × estado, conversión (tasa cerrada y total), MRR y altas por día coinciden con cálculos hechos a mano sobre 40 organizaciones; la suma de estados = total.
4. **Vencimiento:** el temporizador pasa a `past_due` solo las pruebas vencidas de planes de prueba, es idempotente y **no toca** planes anteriores ni organizaciones sin suscripción.
5. **Aislamiento:** un usuario normal (dueño de una organización) recibe **404** en todas las rutas y páginas del panel; un Super Admin **sin organización** sí entra; revocar la bandera surte efecto en la siguiente petición; un Super Admin sin 2FA recibe 403 `two_factor_required`.
6. **Auditoría y minimización:** cada acción deja `super_admin_audit` con actor, antes/después y motivo; el directorio no devuelve nada de las conversaciones.
7. **Concurrencia:** dos acciones simultáneas sobre la misma organización se serializan (candado de fila) y la bitácora cuadra con el estado final.
8. **Migración:** relleno de eventos aproximados, planes anteriores retirados, índices presentes.

**De punta a punta** (`scripts/e2e-super-admin.mjs`, `pnpm test:e2e:super-admin`; con la app viva)
- Un usuario normal abre `/super-admin` y `GET /api/super-admin/metrics` → **404**.
- El Super Admin (2FA activo en la cuenta de prueba) entra; el dashboard coincide con la base (totales, plan, conversión, MRR) sobre organizaciones sembradas en los 4 planes y los 5 estados.
- Directorio: filtra por plan y estado, busca por correo del dueño, pagina.
- Acciones con la UI real: extender prueba (+7 días y ver los días restantes), cambiar plan, activar (el KPI de conversión y el MRR suben), suspender y cancelar (con el motivo), y ver todo en la historia del cajón.
- Con `SAAS_ENFORCE=true`: la organización suspendida ve `/suscripcion-inactiva` y la API del tenant responde 403 `SUBSCRIPTION_INACTIVE`, mientras el webhook de WhatsApp **sigue** ingiriendo; al reactivarla, vuelve a entrar.
- Registro nuevo (`ALLOW_SIGNUP`) → su organización aparece en el panel como Demo con 14 días.
- Regresión: `e2e-pipeline-tablero` y las Bandeja, que crean organizaciones nuevas.

**Puerta final:** `pnpm typecheck && pnpm lint && pnpm build && pnpm test`, `pnpm test:db` (los 7 fallos previos de `meta-ads-live` no cuentan), E2E del paquete y de regresión, y revisión de capturas.

## Riesgos y compatibilidad

- **Primer dueño de una instalación propia.** `onUserCreated` también asigna Demo de 14 días; con `SAAS_ENFORCE` apagado (el valor por defecto) no pasa nada, pero quien encienda la bandera en una instalación propia **debe** asignarle un plan (el panel permite activar). Está dicho en el CHANGELOG y en la guía.
- **Cambio de contrato del alta:** el plan inicial deja de depender del sector (los módulos del sector ya no deciden el plan). Un negocio nuevo de sector «salón» arranca en Demo con **todos** los módulos, así que su menú no aparece bloqueado durante la prueba; al pasar a Emprendedor/Pro verá lo que el plan incluya.
- **Organizaciones existentes:** conservan su suscripción (Básico/Salón) y su acceso; el panel las muestra como «Plan anterior» y puede asignarles uno nuevo. Las que no tienen suscripción se muestran aparte y no se tocan.
- **`is_super_admin` en la tabla de Better Auth.** Hay que comprobar que el adaptador de Drizzle tolera una columna que Better Auth no declara (lo normal: la ignora); si no, se declara con `input: false`. Se verifica con la prueba de alta y de inicio de sesión.
- **MRR es una estimación:** se calcula con el precio de lista de los planes `active`; no sabe de descuentos ni de cortesías manuales hasta que exista el cobro real (paso 2).
- Un Super Admin comprometido ve metadatos de todas las cuentas y puede suspenderlas: de ahí el 2FA obligatorio, la bandera solo por backend, la auditoría y la minimización de datos.
- Todo se probará contra datos sembrados, no con volumen real de producción.

## Fuera de alcance (pasos posteriores)

Mercado Pago (cobro, webhooks de pago, renovación y reintentos); editar planes y precios desde el panel; aplicar los límites `maxStaff` y `maxMonthlyAiTurns`; pausar el agente y las automatizaciones por suscripción vencida; facturación/comprobantes; descuentos y cupones; correos de aviso («tu prueba termina en 3 días»); multi-moneda; roles de plataforma intermedios (soporte de solo lectura).

## Preguntas de revisión (con el valor que usaré si no se contestan)

- **Q1.** ¿Qué incluye la **Demo**? **Recomendado: todo** (los módulos y canales de Pro), limitada solo por los 14 días: para que la prueba muestre el producto completo y la conversión no dependa de lo que el plan escondió.
- **Q2.** ¿**2FA obligatorio** para entrar al panel? **Recomendado: sí.**
- **Q3.** Una prueba vencida pasa a **`past_due`** (el estado que pediste para «vencidas»), con `status_reason = 'trial_ended'` para distinguirla de un pago atrasado. ¿Prefieres otro estado?
- **Q4.** Con `SAAS_ENFORCE=true`, ¿se pausan también el agente de IA y las automatizaciones de una organización vencida? **Recomendado: no en este paso** (solo se bloquea el acceso a la app; los mensajes entrantes siguen guardándose). Pausar lo saliente es una decisión de negocio que conviene tomar junto con el cobro.
- **Q5.** Los planes **Básico y Salón** actuales: **recomendado retirarlos** (`active = false`) conservando el acceso de quien ya los tiene. ¿O prefieres migrar esas organizaciones a Demo?
- **Q6.** Límites y módulos de **Emprendedor/Pro/Enterprise** (tabla de §2): ¿los confirmas o los ajustas? Hoy los límites solo se declaran.
- **Q7.** Una activación **manual** desde el panel, ¿cuenta como conversión? **Recomendado: sí, marcada `source = admin`**, para separar luego los pagos reales de las cortesías.
- **Q8.** Un **Super Admin sin organización** (cuenta de operador pura): **recomendado permitirlo** (entra directo a `/super-admin`). ¿O siempre debe pertenecer a una?
