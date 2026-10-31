import { customAlphabet } from "nanoid";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const nano = customAlphabet(alphabet, 20);

const prefixes = {
  organization: "org",
  member: "mem",
  contact: "ct",
  conversation: "cv",
  message: "msg",
  lead: "ld",
  stage: "stg",
  leadStageEvent: "lse",
  credentials: "cred",
  agentProfile: "agp",
  kbEntry: "kb",
  template: "tpl",
  testRun: "run",
  testCase: "case",
  mediaAsset: "ma",
  // Módulo Medios — la biblioteca de imágenes y videos
  mediaLibraryItem: "med",
  // 015 — motor de agenda
  calendarSettings: "cal",
  booking: "bk",
  offeredSlot: "ofs",
  zoomCredentials: "zcred",
  googleCredentials: "gcred",
  // 016 — atribución de anuncios
  adAttribution: "att",
  conversionEvent: "cve",
  capiSettings: "capi",
  // Ajustes → IA (issue #85)
  aiCredentials: "aicred",
  // 021 — despacho al cerebro
  dispatch: "dsp",
  // 026 — el aviso de que una conversación se eliminó
  olvido: "olv",
  // Módulo SALON — catálogo, equipo y caja
  service: "srv",
  combo: "cmb",
  staff: "stf",
  staffServiceCommission: "ssc",
  staffSchedule: "sch",
  serviceSale: "sls",
  serviceSaleItem: "sli",
  serviceSaleDateChange: "sdc",
  serviceSaleEdit: "sed",
  // Notificaciones del equipo (campanita y /notificaciones)
  notification: "ntf",
  // Egresos y gastos operativos
  expenseItem: "exi",
  // Fidelización virtual
  loyaltySettings: "lgs",
  customerLoyaltyCard: "clc",
  loyaltyTransaction: "ltr",
  // Cuadre de caja y preferencias de vista
  cashRegisterShift: "shf",
  userUiPreferences: "pref",
} as const;

export type IdKind = keyof typeof prefixes;

export function newId(kind: IdKind): string {
  return `${prefixes[kind]}_${nano()}`;
}
