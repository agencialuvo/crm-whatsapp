import { z } from "zod";
import { ICON_CATALOG, ICON_KEYS, type IconKey } from "@/lib/icon-catalog";
import {
  NAV_BOTTOM_GROUP,
  NAV_GROUP_KEYS,
  NAV_ITEM_GROUP,
  NAV_ITEM_KEYS,
  isProtectedItem,
  type NavGroupKey,
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
 */

export const MENU_NAME_MAX = 30;
export const MENU_TEMPLATE_NAME_MAX = 40;
export const MENU_MAX_TEMPLATES = 20;

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

const groupPref = z
  .object({
    key: z.enum(NAV_GROUP_KEYS, { errorMap: () => ({ message: "Ese bloque del menú no existe" }) }),
    title: label.nullish(),
    hidden: z.boolean().optional(),
    items: z.array(itemPref).max(NAV_ITEM_KEYS.length),
  })
  .strict();

export const menuConfigSchema = z
  .object({
    v: z.literal(1),
    groups: z.array(groupPref).max(NAV_GROUP_KEYS.length),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const groups = new Set<string>();
    const items = new Set<string>();
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
  key: NavGroupKey;
  title: string | undefined;
  /** El título de siempre; un bloque sin título (entrada suelta) no se renombra. */
  defaultTitle: string | undefined;
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
    bottom: g.bottom === true,
    hidden: false,
    items: [],
  });

  // 1. Los bloques en el orden de la configuración.
  for (const cg of config?.groups ?? []) {
    const bg = baseGroups.get(cg.key);
    if (!bg || out.some((o) => o.key === cg.key)) continue;
    const rg = open(bg);
    rg.hidden = cg.hidden === true && !rg.bottom;
    if (cg.title && bg.title) rg.title = cg.title.trim();
    for (const ci of cg.items) {
      const info = itemInfo.get(ci.key);
      if (!info || placed.has(ci.key)) continue;
      // El bloque de abajo solo lleva lo suyo y lo suyo no sale de él.
      if ((bg.bottom === true) !== (info.group.bottom === true)) continue;
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
      ...(g.title !== undefined && g.title !== g.defaultTitle && { title: g.title }),
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
      "Para asesorías, consultoría y diagnósticos: Panel, Caja y Citas primero, «Programas» en lugar de Servicios, y sin Equipo ni Gastos a la vista.",
    config: {
      v: 1,
      groups: [
        { key: "trabajo", items: [{ key: "panel" }, { key: "caja" }, { key: "citas" }, { key: "clientes" }] },
        {
          key: "gestion",
          items: [
            { key: "servicios", label: "Programas", iconKey: "graduationCap" },
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
];

export function findSystemTemplate(key: string | null | undefined): MenuTemplate | null {
  return MENU_SYSTEM_TEMPLATES.find((t) => t.key === key) ?? null;
}

/** La plantilla que se recomienda para un tipo de negocio (solo una sugerencia: nada se aplica solo). */
export function suggestedTemplateKey(categoryKey: string | null | undefined): string {
  return categoryKey === "personal_brand" ? "marca-personal" : "estandar";
}
