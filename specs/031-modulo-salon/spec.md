# Feature Specification: Módulo SALON — barberías, salones y manicure

**Feature Branch**: `feat/031-modulo-salon`

**Created**: 2026-10-17

**Status**: Implementada; gates y guion E2E en verde ([tests/e2e/us-salon.md](../../tests/e2e/us-salon.md),
arnés `scripts/e2e-salon.mjs`).

**Carril**: ciclo completo (Principio VI). Añade seis tablas y una columna
(migración aditiva `0021`), cambia un índice y corrige el cálculo de ocupación
del motor de agenda. No cambia ningún contrato publicado (`/api/bot/*`,
despacho, webhooks, `/api/health`).

## El problema

Un negocio de servicios con **varias personas atendiendo a la vez** (una
barbería con tres sillas, un salón, un local de manicure) no cabe en el motor
de citas de una sola agenda: no sabe cuánto cuesta cada cosa, quién atendió,
cuánto le toca a cada quien, ni cuánto entró hoy. Tampoco puede anunciar una
oferta en Meta o TikTok y reconocerla cuando el cliente escribe.

## Qué entrega

Tres páginas propias con su entrada en el menú debajo de Citas (solo con `SALON=on`): `/servicios`, `/equipo` y `/caja`; y la **agenda por sillas como vista principal de Citas** (`/citas`, pestañas «Por barberos» y «Calendario general»).

| Pantalla | Quién | Qué hace |
|---|---|---|
| Servicios y ofertas | dueño/administrador | CRUD de servicios (precio, duración, comisión por defecto) y ofertas de publicidad pagada con su **palabra clave** (única, normalizada: `COMBO_FRESH`) |
| Equipo | dueño/administrador | Alta de profesionales, estado, **comisión global (50 % por defecto)**, **pactos por servicio**, horario semanal y **días libres** |
| Caja | dueño/administrador | Cierre por rango (Hoy, Ayer, 7 días, Este mes, Mes pasado o fechas): ingresos, comisiones del equipo, ganancia neta, lo que se le paga a cada profesional, cuadre por método (Efectivo, Yape, Plin, Tarjeta, Otro), tabla de ventas, CSV y anulación |
| Agenda por sillas | todo el equipo (necesita `AGENDA=on`) | Una columna por profesional, franjas del motor de disponibilidad, cupos libres por franja, en vivo; asignar profesional y cobrar desde la cita |

Cobrar (registrar una venta) lo puede hacer todo el equipo; ver la caja, el
equipo con sus comisiones o el catálogo, no.

## Decisiones

- **D1 — Bandera `SALON`**, apagada por defecto, con el patrón de ADR-001: sin
  ella no hay menú, pantallas ni rutas (404) y la migración se aplica igual.
  `src/server/business/flag.ts` reutiliza los valores de «encendida» de
  `AGENDA`.
- **D2 — Dinero en centavos enteros y reparto en el servidor.** La UI nunca
  calcula la comisión que se guarda. `splitAmount`: la comisión se redondea al
  centavo y el neto es el **resto**, de modo que `comisión + neto = monto`
  siempre (un `CHECK` de la base lo exige).
- **D3 — Qué porcentaje manda**, de lo más específico a lo más general: el de
  la venta → el pactado profesional × servicio → el global del profesional →
  el por defecto del servicio → 50 %. Un valor fuera de 0-100 se ignora.
- **D4 — Las ventas son historia financiera.** Sobreviven al borrado de un
  contacto (`customer_name` guarda el nombre al cobrar) y no se borran con el
  servicio, combo o profesional: la API responde `409 in_use` y la UI ofrece
  **desactivar**. Una cita se cobra una sola vez (índice único parcial en
  `booking_id`). Un cobro mal hecho se **anula** (solo dueño/administrador).
- **D5 — Multicupo en la base.** `booking_org_active_slot_uq` pasa de «único
  por instante» a «único por instante **y silla**» con
  `coalesce(staff_id, '')`. Las citas sin asignar siguen chocando entre sí
  exactamente como antes (una instancia que no usa sillas no nota el cambio) y
  cada profesional puede tener una cita a la misma hora. Asignar a alguien que
  ya está ocupado es un `409 staff_busy` que la base garantiza.
- **D6 — El motor llena una franja cuando coinciden tantas citas como
  profesionales activos** (`buildBusyIntervals`: barrido de la línea de tiempo
  con la duración real de cada cita). Un **bloqueo** siempre ocupa su
  intervalo. *(El primer borrador de este cálculo, nunca publicado, contaba solo
  las citas con la misma hora de inicio, fijaba 30 min y trataba un bloqueo como
  una cita más: con 3 sillas, «Bloquear horario» dejaba de bloquear. Lo detectó
  el guion E2E.)*
- **D7 — El tablero reutiliza las franjas del motor**
  (`buildCandidateSlots`) y les añade cupos: profesionales de turno (su
  horario y días libres) menos las citas que ocupan la franja. Sin ningún
  profesional dado de alta hay una silla, igual que el motor.
- **D8 — Zona y moneda del negocio, no del navegador.** El «hoy» y los cortes
  de día de la caja salen de `businessTimezone` (Ajustes → Agenda) y los
  montos se escriben con la moneda de Ajustes → Marca. El servidor resuelve
  ambas y las baja como props.
- **D9 — CSV a prueba de fórmulas.** Un nombre de cliente es input externo; una
  celda que empieza con `= + - @` se neutraliza antes de abrirla en Excel.

## Modelo de datos (migración `0021`)

`service`, `combo`, `staff`, `staff_service_commission`, `staff_schedule`,
`service_sale` (todas con `organization_id`, índices org-first, `CHECK`s de
porcentajes, precios y reparto) y `booking.staff_id` (nulo = sin asignar; al
borrar al profesional la cita queda sin asignar). Prefijos de id: `srv`, `cmb`,
`stf`, `ssc`, `sch`, `sls`.

## API (`/api/negocio/*`)

| Ruta | Quién |
|---|---|
| `servicios`, `combos`, `equipo` (+ `[id]`, `equipo/[id]/horario`, `equipo/[id]/comisiones`) | dueño/administrador |
| `ventas` GET (reporte por `?from&to`), `ventas/[id]` DELETE | dueño/administrador |
| `ventas` POST, `opciones` (sin comisiones) | todo el equipo |
| `agenda?date=` y `agenda/citas/[id]/profesional` (PUT) | todo el equipo; además `AGENDA=on` |

Errores con el sobre de siempre `{ error: { code, message } }`: `422`
validación (Zod, el mismo esquema que usan los formularios), `404`, `409`
(`keyword_taken`, `in_use`, `already_sold`, `staff_busy`, `staff_inactive`,
`item_inactive`, `booking_not_chargeable`, `test_booking`) y `403`/`401`.

## Límites conocidos (decisiones, no olvidos)

- **La palabra clave de una oferta se guarda y se muestra al agente en el
  contexto del negocio, pero detectarla en un mensaje entrante de un anuncio y
  ofrecer la oferta automáticamente no está conectado** (`src/server/ai/barbershop-*`
  son trabajo en curso fuera de esta spec).
- **El motor cuenta la capacidad como «profesionales activos»** y no mira sus
  turnos; el tablero sí. En un día en que alguien está libre, el motor puede
  ofrecer una franja que el tablero ya ve llena; el choque se resuelve sin
  sobreventa porque solo cabe **una cita sin asignar por instante**.
- **Una segunda cita simultánea requiere asignar la primera** (a quien la
  atenderá): mientras la primera siga «sin asignar», otra sin asignar a la
  misma hora responde `409 slot_taken`.
- Las ventas no se editan: se anulan y se registran de nuevo.
- `service.photo_url` existe en el esquema y no tiene pantalla todavía.

## Verificación

`pnpm typecheck && pnpm lint && pnpm test && pnpm build` con `SALON` apagada y
encendida (matriz del CI), `tests/unit/salon-*.test.ts` y
`tests/unit/availability-multicupo.test.ts`, y
`node --env-file=.env scripts/e2e-salon.mjs` contra la app viva (203
comprobaciones: API, navegador, móvil y permisos; con `SALON` apagada comprueba
que todo es 404).
