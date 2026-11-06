/** Un sector de negocio del catálogo (`business_category`). Sin imports de servidor: lo usan los componentes. */
export type BusinessSector = {
  key: string;
  name: string;
  description: string | null;
};

/** Formato de la llave de un sector (`salon`, `health`…): corto y sin espacios ni mayúsculas. */
export const SECTOR_KEY_PATTERN = /^[a-z0-9_-]{1,40}$/;

/** El sector con el que nace todo negocio hasta que su propietario elige otro. */
export const DEFAULT_SECTOR_KEY = "salon";

/** Aviso a los componentes que leen el contexto de la organización (plan, módulos) de que cambió. */
export const ORG_CONTEXT_CHANGED_EVENT = "vocero:org-context-changed";
