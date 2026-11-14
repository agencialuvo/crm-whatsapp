import { z } from "zod";

/**
 * Etiquetas de contacto — contratos compartidos cliente/servidor.
 *
 * El color es una CLAVE de la paleta, no un valor libre: cada clave se pinta con tokens del sistema de
 * diseño y se ve bien en tema claro y oscuro.
 */

export const TAG_COLORS = ["slate", "blue", "green", "amber", "red", "violet", "pink"] as const;
export type TagColor = (typeof TAG_COLORS)[number];

/** Clases de Tailwind por color (chip). Estáticas para que el compilador las vea. */
export const TAG_COLOR_CLASSES: Record<TagColor, string> = {
  slate: "border-border bg-subtle text-text-2",
  blue: "border-blue-300/60 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  green: "border-green-300/60 bg-green-500/10 text-green-700 dark:text-green-300",
  amber: "border-amber-300/60 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  red: "border-red-300/60 bg-red-500/10 text-red-700 dark:text-red-300",
  violet: "border-violet-300/60 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  pink: "border-pink-300/60 bg-pink-500/10 text-pink-700 dark:text-pink-300",
};

export const tagColorClass = (color: string): string =>
  TAG_COLOR_CLASSES[(TAG_COLORS as readonly string[]).includes(color) ? (color as TagColor) : "slate"];

export const TAG_NAME_MAX = 40;
/** Un contacto con cientos de etiquetas es un error de uso, no un caso real. */
export const MAX_TAGS_PER_ORG = 200;

export const tagNameSchema = z
  .string()
  .trim()
  .min(1, "Escribe un nombre")
  .max(TAG_NAME_MAX, `Máximo ${TAG_NAME_MAX} caracteres`);

export const tagCreateSchema = z.object({
  name: tagNameSchema,
  color: z.enum(TAG_COLORS).default("slate"),
});
export type TagCreateInput = z.infer<typeof tagCreateSchema>;

export const tagPatchSchema = z
  .object({ name: tagNameSchema.optional(), color: z.enum(TAG_COLORS).optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Envía al menos un campo para actualizar" });
export type TagPatchInput = z.infer<typeof tagPatchSchema>;

/** Asignar: una etiqueta existente (`tagId`) o una nueva «al vuelo» (`name` + `color`). */
export const tagAssignSchema = z.union([
  z.object({ tagId: z.string().trim().min(1).max(64) }).strict(),
  tagCreateSchema.strict(),
]);
export type TagAssignInput = z.infer<typeof tagAssignSchema>;

export type TagDto = { id: string; name: string; color: string };
/** En la lista de administración: cuántos contactos la tienen. */
export type TagWithCount = TagDto & { contactCount: number };

/** Clave de comparación: sin mayúsculas ni acentos de más (`Vip` = `vip` = ` VIP `). */
export const tagKey = (name: string): string => name.trim().toLocaleLowerCase("es");
