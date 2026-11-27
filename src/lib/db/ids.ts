import { customAlphabet } from "nanoid";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const nano = customAlphabet(alphabet, 20);

const prefixes = {
  organization: "org",
  member: "mem",
  contact: "ct",
  conversation: "cv",
  message: "msg",
  // 041 — estado de entrega que llegó antes que su mensaje
  messageStatusOrphan: "mso",
  lead: "ld",
  stage: "stg",
  leadStageEvent: "lse",
  credentials: "cred",
  agentProfile: "agp",
  kbEntry: "kb",
  template: "tpl",
  testRun: "run",
  testCase: "case",
  // Agente — números que el agente de IA ignora
  ignoredNumber: "ign",
  mediaAsset: "ma",
  // SaaS & Multi-sector
  plan: "plan",
  subscription: "sub",
  // 045 — Super Admin
  subscriptionEvent: "sev",
  billingCheckout: "bck",
  billingPayment: "bpy",
  billingWebhookEvent: "bwh",
  superAdminAudit: "saa",
  businessCategory: "bcat",
  businessProfile: "bpro",
  // Módulo Medios — la biblioteca de imágenes y videos
  mediaLibraryItem: "med",
  whatsappMediaCache: "wmc",
  // 015 — motor de agenda
  calendarSettings: "cal",
  booking: "bk",
  offeredSlot: "ofs",
  zoomCredentials: "zcred",
  googleCredentials: "gcred",
  // Mejora 3 — calendario por profesional
  staffGoogleConnection: "sgc",
  staffCalendarInvite: "sci",
  // Mejora 4 — canales de avisos (`watch`) de Google Calendar
  googleWatchChannel: "gwc",
  // 016 — atribución de anuncios
  adAttribution: "att",
  conversionEvent: "cve",
  capiSettings: "capi",
  // 038 — Marketing API de Meta
  metaAdsSettings: "mas",
  metaAd: "mad",
  metaAdSpend: "msp",
  metaAccountSpend: "mac",
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
  // Cumpleaños: saludo manual registrado desde el Panel (uno por cliente y año)
  birthdayGreeting: "bgr",
  // Cumpleaños: rescate de fin de mes («Última oportunidad»), uno por cliente y mes
  birthdayRescue: "brs",
  // Cumpleaños: ajustes del rescate y control de avisos de la campanita
  birthdayRescueSettings: "brt",
  birthdayAlert: "bra",
  // Cuadre de caja y preferencias de vista
  cashRegisterShift: "shf",
  userUiPreferences: "pref",
  // Menú lateral: configuración activa y plantillas guardadas por organización
  menuConfig: "mnu",
  // Enrutamiento por anuncio: qué servicio u oferta persigue el agente según el anuncio de origen
  adFlow: "adf",
  // Automatizaciones — flujos, pasos y cola de ejecución
  // Etiquetas de contacto
  tag: "tag",
  automationFlow: "aut",
  automationStep: "stp",
  automationQueue: "que",
  automationEdge: "edg",
  automationRun: "arn",
  automationExecutionLog: "log",
  // Monedas (IA y WhatsApp): bolsa, libro de movimientos, medición, tarifas y recargas
  creditAccount: "cra",
  creditLedger: "crl",
  creditUsage: "cru",
  creditRate: "crr",
  creditPack: "crk",
  creditTopup: "crt",
  creditAlert: "cral",
} as const;

export type IdKind = keyof typeof prefixes;

export function newId(kind: IdKind): string {
  return `${prefixes[kind]}_${nano()}`;
}
