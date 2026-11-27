/**
 * Mejora 1 — El «ahora» del negocio para el agente. Pura (sin base de datos): la fecha, la hora y la zona
 * horaria del negocio, y, si la agenda está encendida, su horario semanal con si está abierto en este momento.
 *
 * Sin esto el modelo no sabía qué día era: «¿abren hoy?» o «¿a qué hora cierran?» se contestaban adivinando,
 * salvo en la lista de huecos de la agenda (que sí trae fechas).
 */

type Intervalo = { start: string; end: string };
export type HorarioSemanal = Partial<Record<string, Intervalo[]>>;

/** Mismo orden y llaves que `WEEKDAYS` de la agenda. */
const DIAS: { key: string; nombre: string }[] = [
  { key: "mon", nombre: "lunes" },
  { key: "tue", nombre: "martes" },
  { key: "wed", nombre: "miércoles" },
  { key: "thu", nombre: "jueves" },
  { key: "fri", nombre: "viernes" },
  { key: "sat", nombre: "sábado" },
  { key: "sun", nombre: "domingo" },
];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function intervalosValidos(valor: unknown): Intervalo[] {
  if (!Array.isArray(valor)) return [];
  return valor.filter(
    (i): i is Intervalo =>
      !!i &&
      typeof i === "object" &&
      typeof (i as Intervalo).start === "string" &&
      typeof (i as Intervalo).end === "string" &&
      HHMM.test((i as Intervalo).start) &&
      HHMM.test((i as Intervalo).end) &&
      (i as Intervalo).start < (i as Intervalo).end
  );
}

/** Día de la semana (`mon`…`sun`) y hora `HH:MM` de pared en la zona del negocio. */
export function relojLocal(now: Date, timeZone: string): { dia: string; hora: string } {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const leer = (t: string) => partes.find((p) => p.type === t)?.value ?? "";
  const dia = leer("weekday").toLowerCase().slice(0, 3);
  return { dia, hora: `${leer("hour")}:${leer("minute")}` };
}

/** «lunes 09:00–14:00 y 16:00–20:00; martes cerrado; …». */
export function describirHorario(horario: HorarioSemanal): string {
  return DIAS.map(({ key, nombre }) => {
    const tramos = intervalosValidos(horario[key]);
    return tramos.length
      ? `${nombre} ${tramos.map((t) => `${t.start}–${t.end}`).join(" y ")}`
      : `${nombre} cerrado`;
  }).join("; ");
}

/** ¿El negocio está dentro de su horario ahora mismo? `null` si el horario no tiene ningún tramo. */
export function abiertoAhora(now: Date, timeZone: string, horario: HorarioSemanal): boolean | null {
  const todos = DIAS.flatMap(({ key }) => intervalosValidos(horario[key]));
  if (!todos.length) return null;
  const { dia, hora } = relojLocal(now, timeZone);
  return intervalosValidos(horario[dia]).some((t) => hora >= t.start && hora < t.end);
}

/**
 * Las líneas del system prompt. `horario` solo cuando la agenda está encendida: es el horario en que se
 * atiende con cita. El conocimiento del negocio sigue mandando si dice otro horario de atención.
 */
export function contextoTemporal(input: {
  now: Date;
  timeZone: string;
  horario?: HorarioSemanal | null;
}): string {
  const { now, timeZone } = input;
  const fecha = new Intl.DateTimeFormat("es-MX", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);
  const { hora } = relojLocal(now, timeZone);
  const lineas = [
    `FECHA Y HORA ACTUAL DEL NEGOCIO: ${fecha}, ${hora} (zona horaria ${timeZone}). Úsala para entender «hoy», «mañana», «este fin de semana» o «ahora»; no supongas otra fecha.`,
  ];
  if (input.horario) {
    const abierto = abiertoAhora(now, timeZone, input.horario);
    if (abierto !== null) {
      lineas.push(
        `HORARIO DE ATENCIÓN CON CITA (de la agenda, hora local): ${describirHorario(input.horario)}. En este momento el negocio está ${abierto ? "DENTRO" : "FUERA"} de ese horario. Si el conocimiento del negocio indica otro horario de atención, manda el conocimiento.`
      );
    }
  }
  return lineas.join("\n");
}
