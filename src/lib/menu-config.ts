import { z } from "zod";
import { ICON_CATALOG, ICON_KEYS, type IconKey } from "@/lib/icon-catalog";
import {
  NAV_BOTTOM_GROUP,
  NAV_GROUP_KEYS,
  NAV_ITEM_GROUP,
  NAV_ITEM_KEYS,
  isCustomGroupKey,
  isProtectedItem,
  type NavItemKey,
} from "@/lib/nav-keys";
import type { NavGroup, NavItem } from "@/lib/nav";

/**
 * El menú lateral personalizable: esquema de validación, resolución y plantillas base. Puro y sin servidor: lo leen el
 * menú (cliente), la pantalla de Ajustes y el servidor.
 *
 * Reglas que no se negocian:
 * - Es SOLO presentación: visibilidad, orden, nombres e iconos. Nunca concede acceso a nada, nunca bloquea una ruta y
 *   nunca borra datos: las pantallas se protegen con sus guardias (bandera, rol, plan), no con el menú.
 * - Nunca AGREGA entradas: parte de lo que el menú base ya trae para esta persona (banderas, rol) y solo lo reordena,
 *   oculta o renombra. Una llave que el menú base no trae para quien mira se ignora.
 * - «Ajustes» no se puede ocultar. Un bloque que se queda sin entradas visibles desaparece solo.
 * - Una entrada vive en UNA sola sección: nunca dos. El esquema rechaza el repetido, `resolveMenu` descarta el segundo
 *   y las operaciones del editor (`moveItemToGroup`) la quitan de donde estaba antes de ponerla en otro lado.
 * - Además de las 5 secciones fijas, una organización puede crear secciones PROPIAS (`sec-…`, hasta
 *   `MENU_MAX_CUSTOM_GROUPS`). Eliminarla devuelve sus entradas a su sección de siempre: no se pierde ni se borra nada.
 */

export const MENU_NAME_MAX = 30;
export const MENU_TEMPLATE_NAME_MAX = 40;
export const MENU_MAX_TEMPLATES = 20;
/** Cuántas secciones propias puede crear una organización (las 5 fijas no cuentan). */
export const MENU_MAX_CUSTOM_GROUPS = 6;

/** Sin caracteres de control ni `<` `>`: es un rótulo, no marcado. */
const LABEL_CHARS = /^[^\u0000-\u001f\u007f<>]+$/;

const label = z
  .string({ invalid_type_error: "El nombre debe ser texto" })
  .trim()
  .min(1, "El nombre no puede quedar vacío")
  .max(MENU_NAME_MAX, `El nombre admite hasta ${MENU_NAME_MAX} caracteres`)
  .regex(LABEL_CHARS, "El nombre tiene caracteres no permitidos");

const itemPref = z
  .object({
    key: z.enum(NAV_ITEM_KEYS, { errorMap: () => ({ message: "Ese ítem del menú no existe" }) }),
    /** Nombre propio; ausente = el de siempre. */
    label: label.nullish(),
    /** Icono del catálogo propio; ausente = el de siempre. */
    iconKey: z.enum(ICON_KEYS, { errorMap: () => ({ message: "Ese icono no está en el catálogo" }) }).nullish(),
    hidden: z.boolean().optional(),
  })
  .strict();

const groupKey = z
  .string({ invalid_type_error: "Ese bloque del menú no existe", required_error: "Ese bloque del menú no existe" })
  .refine((k) => (NAV_GROUP_KEYS as readonly string[]).includes(k) || isCustomGroupKey(k), "Ese bloque del menú no existe");

const groupPref = z
  .object({
    key: groupKey,
    title: label.nullish(),
    hidden: z.boolean().optional(),
    items: z.array(itemPref).max(NAV_ITEM_KEYS.length),
  })
  .strict();

export const menuConfigSchema = z
  .object({
    v: z.literal(1),
    groups: z.array(groupPref).max(NAV_GROUP_KEYS.length + MENU_MAX_CUSTOM_GROUPS),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const groups = new Set<string>();
    const items = new Set<string>();
    if (cfg.groups.filter((g) => isCustomGroupKey(g.key)).length > MENU_MAX_CUSTOM_GROUPS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["groups"],
        message: `Puedes crear hasta ${MENU_MAX_CUSTOM_GROUPS} secciones propias`,
      });
    }
    cfg.groups.forEach((g, gi) => {
      if (groups.has(g.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["groups", gi, "key"], message: "Hay un bloque repetido" });
      }
      groups.add(g.key);
      if (g.key === NAV_BOTTOM_GROUP && g.hidden) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["groups", gi, "hidden"], message: "El bloque «Sistema» no se puede ocultar" });
      }
      g.items.forEach((it, ii) => {
        if (items.has(it.key)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["groups", gi, "items", ii, "key"], message: "Hay un ítem repetido" });
        }
        items.add(it.key);
        if (isProtectedItem(it.key) && it.hidden) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["groups", gi, "items", ii, "hidden"], message: "«Ajustes» no se puede ocultar" });
        }
        // El bloque de abajo solo lleva lo suyo, y lo suyo no sale de él.
        const inBottom = g.key === NAV_BOTTOM_GROUP;
        const belongsToBottom = NAV_ITEM_GROUP[it.key] === NAV_BOTTOM_GROUP;
        if (inBottom !== belongsToBottom) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["groups", gi, "items", ii, "key"],
            message: "Ese ítem no se puede mover a ese bloque",
          });
        }
      });
    });
  });

export type MenuConfig = z.infer<typeof menuConfigSchema>;

/** Una configuración guardada que ya no cumpla el esquema se ignora (vale el menú estándar), jamás rompe el menú. */
export function parseMenuConfig(raw: unknown): MenuConfig | null {
  const parsed = menuConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Nombre de una plantilla guardada. */
export const menuTemplateNameSchema = z
  .string({ required_error: "Escribe un nombre para la plantilla" })
  .trim()
  .min(1, "Escribe un nombre para la plantilla")
  .max(MENU_TEMPLATE_NAME_MAX, `El nombre admite hasta ${MENU_TEMPLATE_NAME_MAX} caracteres`)
  .regex(LABEL_CHARS, "El nombre tiene caracteres no permitidos");

/** De qué plantilla partió una configuración: la llave de una base o el id de una guardada. */
export const menuBaseKeySchema = z
  .string()
  .regex(/^[a-z0-9_-]{1,40}$/, "Plantilla no válida")
  .nullish();

/* ------------------------------ resolución ------------------------------ */

export type ResolvedItem = {
  /** La entrada tal como la trae el menú base (con su rótulo e icono de siempre). */
  item: NavItem;
  label: string;
  iconKey: IconKey;
  hidden: boolean;
  /** «Ajustes»: no se oculta. */
  protected: boolean;
};

export type ResolvedGroup = {
  /** Una de `NAV_GROUP_KEYS` o la de una sección propia (`sec-…`). */
  key: string;
  /** El que se pinta; vacío o ausente = la sección no lleva encabezado. Editable en TODAS las secciones. */
  title: string | undefined;
  /** El título de siempre; `undefined` en una sección sin título base (Resultados, o una propia). */
  defaultTitle: string | undefined;
  /** Sección creada por la organización: se puede eliminar (sus entradas vuelven a su sección de siempre). */
  custom: boolean;
  bottom: boolean;
  hidden: boolean;
  items: ResolvedItem[];
};

function toResolved(item: NavItem, pref?: MenuConfig["groups"][number]["items"][number]): ResolvedItem {
  const isProtected = isProtectedItem(item.key);
  return {
    item,
    label: pref?.label?.trim() || item.label,
    iconKey: pref?.iconKey ?? item.iconKey,
    hidden: isProtected ? false : pref?.hidden === true,
    protected: isProtected,
  };
}

/**
 * El menú completo —incluido lo oculto— que sale de aplicar una configuración al menú base de esta persona. Lo usa
 * la pantalla de Ajustes (necesita ver también lo oculto) y `applyMenuConfig`.
 *
 * Lo que la configuración no menciona (una entrada que el código sumó después) queda en su bloque de siempre; lo que
 * menciona pero el menú base no trae para quien mira (otra bandera, otro rol) se ignora.
 */
export function resolveMenu(base: readonly NavGroup[], config: MenuConfig | null | undefined): ResolvedGroup[] {
  const baseGroups = new Map(base.map((g) => [g.key, g]));
  const itemInfo = new Map<NavItemKey, { item: NavItem; group: NavGroup }>();
  for (const g of base) for (const item of g.items) itemInfo.set(item.key, { item, group: g });

  const placed = new Set<NavItemKey>();
  const out: ResolvedGroup[] = [];
  const open = (g: NavGroup): ResolvedGroup => ({
    key: g.key,
    title: g.title,
    defaultTitle: g.title,
    custom: false,
    bottom: g.bottom === true,
    hidden: false,
    items: [],
  });

  // 1. Los bloques en el orden de la configuración.
  for (const cg of config?.groups ?? []) {
    if (out.some((o) => o.key === cg.key)) continue;
    // Una sección propia no existe en el menú base: nace de la configuración. Una fija solo si el base la trae.
    const custom = isCustomGroupKey(cg.key);
    const bg = custom ? undefined : baseGroups.get(cg.key);
    if (!custom && !bg) continue;
    const rg: ResolvedGroup = bg
      ? open(bg)
      : { key: cg.key, title: undefined, defaultTitle: undefined, custom: true, bottom: false, hidden: false, items: [] };
    rg.hidden = cg.hidden === true && !rg.bottom;
    // El título se conserva en cualquier sección, también en las que no tienen título base.
    if (cg.title?.trim()) rg.title = cg.title.trim();
    for (const ci of cg.items) {
      const info = itemInfo.get(ci.key);
      if (!info || placed.has(ci.key)) continue;
      // El bloque de abajo solo lleva lo suyo y lo suyo no sale de él.
      if (rg.bottom !== (info.group.bottom === true)) continue;
      rg.items.push(toResolved(info.item, ci));
      placed.add(ci.key);
    }
    out.push(rg);
  }

  // 2. Lo que la configuración no mencionó, en su bloque de siempre.
  for (const bg of base) {
    let rg = out.find((o) => o.key === bg.key);
    if (!rg) {
      rg = open(bg);
      out.push(rg);
    }
    for (const item of bg.items) {
      if (placed.has(item.key)) continue;
      rg.items.push(toResolved(item));
      placed.add(item.key);
    }
  }

  // El bloque de abajo siempre queda abajo.
  return [...out.filter((g) => !g.bottom), ...out.filter((g) => g.bottom)];
}

/**
 * El menú que se PINTA: lo oculto sale, y un bloque que se queda sin entradas visibles desaparece solo. Ocultar un
 * bloque oculta todas sus entradas salvo las protegidas («Ajustes»). Sin configuración devuelve el menú base tal cual
 * (mismas entradas, mismos objetos); una entrada sin rótulo ni icono propios conserva su identidad.
 */
export function applyMenuConfig(base: readonly NavGroup[], config: MenuConfig | null | undefined): NavGroup[] {
  if (!config) return base as NavGroup[];
  const groups: NavGroup[] = [];
  for (const rg of resolveMenu(base, config)) {
    const items: NavItem[] = [];
    for (const r of rg.items) {
      if (r.hidden || (rg.hidden && !r.protected)) continue;
      const same = r.label === r.item.label && r.iconKey === r.item.iconKey;
      items.push(same ? r.item : { ...r.item, label: r.label, iconKey: r.iconKey, icon: ICON_CATALOG[r.iconKey] });
    }
    if (items.length === 0) continue;
    groups.push({
      key: rg.key,
      ...(rg.title !== undefined && { title: rg.title }),
      items,
      ...(rg.bottom && { bottom: true }),
    });
  }
  return groups;
}

/**
 * Lo contrario: de lo que quedó en la pantalla de Ajustes a lo que se guarda. Solo se anotan las diferencias contra
 * el menú de siempre (nombre, icono, oculto, título del bloque), más el ORDEN y el bloque de cada entrada.
 */
export function configFromResolved(groups: readonly ResolvedGroup[]): MenuConfig {
  return {
    v: 1,
    groups: groups.map((g) => ({
      key: g.key,
      ...(g.title?.trim() && g.title.trim() !== g.defaultTitle && { title: g.title.trim() }),
      ...(g.hidden && !g.bottom && { hidden: true }),
      items: g.items.map((r) => ({
        key: r.item.key,
        ...(r.label !== r.item.label && { label: r.label }),
        ...(r.iconKey !== r.item.iconKey && { iconKey: r.iconKey }),
        ...(r.hidden && !r.protected && { hidden: true }),
      })),
    })),
  };
}

/* ------------------------ operaciones del editor (puras) ------------------------ */

/** La entrada de `itemKey` en cualquiera de las secciones, con su sección. */
function findItem(groups: readonly ResolvedGroup[], itemKey: string) {
  for (const g of groups) {
    const item = g.items.find((r) => r.item.key === itemKey);
    if (item) return { group: g, item };
  }
  return null;
}

/**
 * Mueve una entrada a otra sección (la agrega al final). La QUITA de donde estaba antes de ponerla: nunca queda en dos
 * secciones. No mueve nada si la sección de destino no existe, si la entrada es del bloque de abajo («Ajustes» y
 * «Notificaciones» no salen de él) o si el destino es el bloque de abajo (nada más entra).
 */
export function moveItemToGroup(groups: readonly ResolvedGroup[], itemKey: string, toKey: string): ResolvedGroup[] {
  const found = findItem(groups, itemKey);
  const to = groups.find((g) => g.key === toKey);
  if (!found || !to || found.group.key === toKey) return [...groups];
  if (found.group.bottom || to.bottom) return [...groups];
  return groups.map((g) => {
    const without = g.items.filter((r) => r.item.key !== itemKey);
    return g.key === toKey ? { ...g, items: [...without, found.item] } : { ...g, items: without };
  });
}

/** Una llave nueva para una sección propia, que no repite ninguna de `taken`. `rand` se inyecta para probarla. */
export function newCustomGroupKey(taken: Iterable<string>, rand: () => number = Math.random): string {
  const used = new Set(taken);
  for (;;) {
    let id = "";
    while (id.length < 6) id += Math.floor(rand() * 36).toString(36);
    const key = `sec-${id}`;
    if (!used.has(key)) return key;
  }
}

export function countCustomGroups(groups: readonly { custom?: boolean }[]): number {
  return groups.filter((g) => g.custom).length;
}

/**
 * Agrega una sección propia vacía justo antes del bloque de abajo. `null` si ya se llegó al tope
 * (`MENU_MAX_CUSTOM_GROUPS`). El título es opcional: sin él, la sección no lleva encabezado.
 */
export function addCustomGroup(
  groups: readonly ResolvedGroup[],
  title?: string,
  rand: () => number = Math.random
): ResolvedGroup[] | null {
  if (countCustomGroups(groups) >= MENU_MAX_CUSTOM_GROUPS) return null;
  const clean = title?.trim().slice(0, MENU_NAME_MAX);
  const fresh: ResolvedGroup = {
    key: newCustomGroupKey(groups.map((g) => g.key), rand),
    title: clean || undefined,
    defaultTitle: undefined,
    custom: true,
    bottom: false,
    hidden: false,
    items: [],
  };
  return [...groups.filter((g) => !g.bottom), fresh, ...groups.filter((g) => g.bottom)];
}

/**
 * Elimina una sección PROPIA. Sus entradas no se pierden ni se borran: vuelven al final de la sección donde nacen
 * (`NAV_ITEM_GROUP`) conservando nombre, icono y si estaban ocultas; si esa sección no está para quien mira, a la
 * primera sección que no sea la de abajo. Una sección fija no se elimina.
 */
export function removeCustomGroup(groups: readonly ResolvedGroup[], key: string): ResolvedGroup[] {
  const doomed = groups.find((g) => g.key === key);
  if (!doomed || !doomed.custom) return [...groups];
  const rest = groups.filter((g) => g.key !== key).map((g) => ({ ...g, items: [...g.items] }));
  const fallback = rest.find((g) => !g.bottom);
  for (const r of doomed.items) {
    const home = rest.find((g) => g.key === NAV_ITEM_GROUP[r.item.key]) ?? fallback;
    if (home && !rest.some((g) => g.items.some((x) => x.item.key === r.item.key))) home.items.push(r);
  }
  return rest;
}

/* --------------------------- plantillas del sistema --------------------------- */

export type MenuTemplate = {
  key: string;
  name: string;
  description: string;
  /** `null` = el menú estándar (sin personalizar). */
  config: MenuConfig | null;
};

/**
 * Las plantillas BASE: viven en código y son de solo lectura. Elegir una copia su contenido a la configuración activa
 * de la organización; editarla después nunca la sobrescribe (la copia de la organización es la que cambia, o se
 * guarda como plantilla nueva).
 */
export const MENU_SYSTEM_TEMPLATES: readonly MenuTemplate[] = [
  {
    key: "estandar",
    name: "Estándar",
    description: "El menú de siempre: todo lo que tu plan y tu rol permiten, en el orden original.",
    config: null,
  },
  {
    key: "marca-personal",
    name: "Marca personal",
    description:
      "Para asesorías, consultoría y diagnósticos: Panel, Caja y Citas primero, Servicios con el nombre de siempre, y sin Equipo ni Gastos a la vista.",
    config: {
      v: 1,
      groups: [
        { key: "trabajo", items: [{ key: "panel" }, { key: "caja" }, { key: "citas" }, { key: "clientes" }] },
        {
          key: "gestion",
          items: [
            { key: "servicios" },
            { key: "contactos" },
            { key: "medios" },
            { key: "automatizaciones" },
            { key: "equipo", hidden: true },
            { key: "gastos", hidden: true },
          ],
        },
        { key: "sistema", items: [{ key: "notificaciones" }, { key: "ajustes" }] },
      ],
    },
  },
  {
    key: "salon-barberia",
    name: "Salón / Barbería",
    description: "El menú de siempre, con Servicios con el icono de tijeras.",
    config: {
      v: 1,
      groups: [
        { key: "trabajo", items: [] },
        { key: "gestion", items: [{ key: "servicios", iconKey: "scissors" }] },
        { key: "agente", items: [] },
        { key: "resultados", items: [] },
        { key: "sistema", items: [] },
      ],
    },
  },
];

export function findSystemTemplate(key: string | null | undefined): MenuTemplate | null {
  return MENU_SYSTEM_TEMPLATES.find((t) => t.key === key) ?? null;
}

/**
 * La plantilla de sistema que corresponde a cada tipo de negocio. Sin entrada, «Estándar». Es lo que se recomienda en
 * Ajustes → Menú y lo que se aplica al ELEGIR el tipo de negocio si la organización no tiene un menú propio
 * (`syncSectorMenu`).
 */
const SECTOR_TEMPLATE: Readonly<Record<string, string>> = {
  personal_brand: "marca-personal",
  salon: "salon-barberia",
};

export function suggestedTemplateKey(categoryKey: string | null | undefined): string {
  // hasOwn: una llave como «__proto__» o «constructor» no debe resolverse contra el prototipo del objeto.
  return categoryKey && Object.hasOwn(SECTOR_TEMPLATE, categoryKey) ? SECTOR_TEMPLATE[categoryKey]! : "estandar";
}
