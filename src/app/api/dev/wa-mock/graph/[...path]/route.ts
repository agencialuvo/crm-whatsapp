import { deflateSync, crc32 } from "node:zlib";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { mockGuard } from "@/lib/dev-guard";
import { getEnv } from "@/lib/env";
import {
  getWaMockState,
  nextN,
  nextOutboundWamid,
  type MockTemplate,
} from "@/server/dev/wa-mock-state";

/**
 * Imitación de la Graph API (contrato mocks.md). El cliente real apunta aquí
 * cuando META_GRAPH_BASE_URL = <app>/api/dev/wa-mock/graph — el código de
 * producción no sabe que habla con un mock.
 */
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ path: string[] }> };

/** 016 — Catálogo cerrado de Meta para `business_messaging` (mismo que el real). */
const CAPI_EVENT_NAMES = new Set([
  "Purchase",
  "LeadSubmitted",
  "QualifiedLead",
  "InitiateCheckout",
  "AddToCart",
  "ViewContent",
  "OrderCreated",
  "OrderShipped",
  "OrderDelivered",
  "OrderCanceled",
  "OrderReturned",
  "CartAbandoned",
  "RatingProvided",
  "ReviewProvided",
]);

/** La app de Meta "dueña" del token en el mock (la que queda suscrita). */
const MOCK_APP = {
  id: "mock-app",
  name: "App de prueba Vocero",
  link: "https://www.facebook.com/games/?app_id=mock-app",
};

function bearerToken(req: Request): string {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

function invalidTokenResponse(): Response {
  return Response.json(
    {
      error: {
        message: "Invalid OAuth access token - Cannot parse access token",
        type: "OAuthException",
        code: 190,
        fbtrace_id: "mock",
      },
    },
    { status: 401 }
  );
}

/**
 * Tokens con los que el mock imita dos rechazos reales de Meta al registrar
 * el webhook: sin `whatsapp_business_management` (código 200) y una app sin
 * callback URL propia (el GET de `webhook_configuration` no trae
 * `application`).
 */
const SIN_GESTION = "-sin-gestion";
const SIN_WEBHOOK_DE_APP = "-sin-app";

function permissionErrorResponse(): Response {
  return Response.json(
    {
      error: {
        message: "(#200) Permissions error",
        type: "OAuthException",
        code: 200,
        fbtrace_id: "mock",
      },
    },
    { status: 403 }
  );
}

function callbackVerificationFailed(failure: string): Response {
  return Response.json(
    {
      error: {
        message: `(#2200) Callback verification failed with the following errors: ${failure}`,
        type: "OAuthException",
        code: 2200,
        fbtrace_id: "mock",
      },
    },
    { status: 400 }
  );
}

/**
 * Meta verifica el callback ANTES de aceptar un override: le hace el mismo
 * GET de suscripción que al configurarlo en el panel, y si no devuelve el
 * challenge, rechaza con 2200. El mock lo hace de verdad contra la URL, así
 * un verify token que no casa con la ruta no pasa en verde.
 *
 * Si la URL es la de esta misma instancia (`APP_BASE_URL`), se le habla por
 * loopback, como hace `deliverToWebhook`: el dominio público puede no
 * resolver desde dentro del proceso y lo que se prueba es la ruta y el token.
 */
async function callbackVerificationError(
  uri: string,
  verifyToken: string
): Promise<string | null> {
  const challenge = String(nextN() * 7919);
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "Invalid URL";
  }
  const own = getEnv().APP_BASE_URL.replace(/\/$/, "");
  if (url.origin === own) {
    url = new URL(`http://127.0.0.1:${process.env.PORT ?? "3000"}${url.pathname}${url.search}`);
  }
  url.searchParams.set("hub.mode", "subscribe");
  url.searchParams.set("hub.challenge", challenge);
  url.searchParams.set("hub.verify_token", verifyToken);
  try {
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();
    if (res.status === 200 && text === challenge) return null;
    return `HTTP Status Code = ${res.status}; the challenge did not match`;
  } catch {
    return "Couldn't connect to server";
  }
}

/** Un teléfono de Meta es solo dígitos; un BSUID lleva prefijo y punto. */
function esSoloDigitos(valor: string): boolean {
  return /^[0-9]+$/.test(valor);
}

/** Quita el segmento de versión (v25.0/...) si viene en la ruta. */
function normalizePath(path: string[]): string[] {
  return path[0] && /^v\d+/.test(path[0]) ? path.slice(1) : path;
}


/**
 * 038 — Marketing API. El mock reproduce lo que importa del contrato real:
 *  - `act_X?fields=name,currency` valida la cuenta;
 *  - `act_X/ads?filtering=[{field:"id",operator:"IN",value:[…]}]` devuelve SOLO los anuncios
 *    que existen (los `gone-*` no vuelven, como uno borrado o de otra cuenta);
 *  - `act_X/insights?level=ad&time_increment=1` devuelve una fila por anuncio y día.
 * Modos de fallo por sufijo del token: `-sinads` (permiso, código 200), `-ratelimit` (código 17),
 * `-fail500` (5xx transitorio) y `-uso-alto` (200 con el uso de la API al 95 %); `-invalid` ya existe.
 */
function marketingFailure(token: string): Response | null {
  if (token.endsWith("-sinads")) {
    return Response.json(
      { error: { message: "(#200) Requires ads_read permission to access this account", type: "OAuthException", code: 200, fbtrace_id: "mock" } },
      { status: 403 }
    );
  }
  if (token.endsWith("-ratelimit")) {
    return Response.json(
      { error: { message: "(#17) User request limit reached", type: "OAuthException", code: 17, fbtrace_id: "mock" } },
      {
        status: 400,
        headers: { "x-business-use-case-usage": JSON.stringify({ "1": [{ type: "ads_insights", call_count: 100, total_cputime: 80, total_time: 90, estimated_time_to_regain_access: 7 }] }) },
      }
    );
  }
  if (token.endsWith("-fail500")) {
    return Response.json(
      { error: { message: "An unexpected error has occurred. Please retry your request later.", type: "OAuthException", code: 2, fbtrace_id: "mock" } },
      { status: 500 }
    );
  }
  return null;
}

function marketingHeaders(token: string): Record<string, string> {
  return token.endsWith("-uso-alto")
    ? { "x-business-use-case-usage": JSON.stringify({ "1": [{ type: "ads_insights", call_count: 95, total_cputime: 10, total_time: 10, estimated_time_to_regain_access: 0 }] }) }
    : {};
}

function idsDelFiltro(url: URL): string[] {
  try {
    const f = JSON.parse(url.searchParams.get("filtering") ?? "[]") as { value?: unknown }[];
    const v = f[0]?.value;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Un anuncio de prueba determinista: su jerarquía sale del número con el que termina su id. */
function mockAd(id: string) {
  const k = Number(id.match(/(\d+)$/)?.[1] ?? 0);
  const c = k % 2;
  return {
    id,
    name: `Anuncio ${id}`,
    adset: { id: `adset-${c}${k % 3}`, name: `Conjunto ${c}${k % 3}` },
    campaign: { id: `camp-${c}`, name: `Campaña ${c}` },
  };
}

function diasEntre(since: string, until: string): string[] {
  const out: string[] = [];
  const fin = Date.parse(`${until}T00:00:00Z`);
  for (let t = Date.parse(`${since}T00:00:00Z`); t <= fin && out.length < 400; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * 039 — La cuenta publicitaria de prueba. Además de los anuncios que ya trajeron gente (los de `ad_attribution`,
 * que en Meta existen en la cuenta), tiene los suyos, con campañas pausadas y anuncios sin una sola conversación:
 *  - acct-ad-1/2/3: «Campaña Alfa» (activa), con gasto
 *  - acct-ad-4: «Campaña Beta» (PAUSADA), con gasto y sin conversaciones
 *  - acct-ad-5: «Campaña Beta» (PAUSADA), sin gasto
 *  - gone-acct-9: gastó pero ya no está en el listado (borrado)
 * Token con sufijo `-descuadre`: el total de la cuenta trae 3,25 al día que ningún anuncio explica.
 */
type AnuncioDeCuenta = {
  id: string;
  name: string;
  status: string;
  adset: { id: string; name: string };
  campaign: { id: string; name: string };
  gasto: number | null;
  listado: boolean;
};

const ANUNCIOS_DE_LA_CUENTA: AnuncioDeCuenta[] = [
  { id: "acct-ad-1", name: "Anuncio Alfa 1", status: "ACTIVE", adset: { id: "acct-set-1", name: "Conjunto Alfa 1" }, campaign: { id: "acct-camp-a", name: "Campaña Alfa" }, gasto: 20, listado: true },
  { id: "acct-ad-2", name: "Anuncio Alfa 2", status: "ACTIVE", adset: { id: "acct-set-1", name: "Conjunto Alfa 1" }, campaign: { id: "acct-camp-a", name: "Campaña Alfa" }, gasto: 15, listado: true },
  { id: "acct-ad-3", name: "Anuncio Alfa 3", status: "ACTIVE", adset: { id: "acct-set-2", name: "Conjunto Alfa 2" }, campaign: { id: "acct-camp-a", name: "Campaña Alfa" }, gasto: 12.5, listado: true },
  { id: "acct-ad-4", name: "Anuncio Beta 1", status: "CAMPAIGN_PAUSED", adset: { id: "acct-set-3", name: "Conjunto Beta 1" }, campaign: { id: "acct-camp-b", name: "Campaña Beta (pausada)" }, gasto: 30, listado: true },
  { id: "acct-ad-5", name: "Anuncio Beta 2", status: "CAMPAIGN_PAUSED", adset: { id: "acct-set-3", name: "Conjunto Beta 1" }, campaign: { id: "acct-camp-b", name: "Campaña Beta (pausada)" }, gasto: null, listado: true },
  { id: "gone-acct-9", name: "Anuncio borrado", status: "DELETED", adset: { id: "acct-set-1", name: "Conjunto Alfa 1" }, campaign: { id: "acct-camp-a", name: "Campaña Alfa" }, gasto: 7, listado: false },
];

/** Los anuncios que ya trajeron gente existen en la cuenta (salvo los `gone-*`, que simulan borrados). */
async function anunciosAtribuidos(): Promise<AnuncioDeCuenta[]> {
  try {
    const filas = await getDb().execute(
      sql`select distinct source_id from ad_attribution where source_id is not null and source_id not like 'gone-%' limit 300`
    );
    return (filas as unknown as { source_id: string }[]).map((r) => {
      const m = mockAd(r.source_id);
      const k = Number(r.source_id.match(/(\d+)$/)?.[1] ?? 0);
      return {
        id: r.source_id,
        name: m.name,
        status: "ACTIVE",
        adset: m.adset,
        campaign: m.campaign,
        gasto: 10 + (k % 5) + 0.5,
        listado: true,
      };
    });
  } catch {
    return [];
  }
}

async function universoDeLaCuenta(): Promise<AnuncioDeCuenta[]> {
  return [...ANUNCIOS_DE_LA_CUENTA, ...(await anunciosAtribuidos())];
}

/**
 * 040 — Creativos de prueba. `acct-ad-1`: titular, texto e imagen. `acct-ad-2`: imagen DEMASIADO grande (pasa del tope de
 * 300 KB de la descarga) y miniatura normal, para probar la caída a la miniatura. `acct-ad-3`: imagen sin titular ni texto
 * (un creativo dinámico). `acct-ad-4`: todo, y en pausa. `acct-ad-5`: sin creativo. Los anuncios que ya trajeron gente
 * traen titular, texto y miniatura. Token con sufijo `-sincreativo`: pedir `creative{…}` falla (error 1, «reduce data»).
 */
const CREATIVOS: Record<string, { title?: string; body?: string; imagen?: "normal" | "grande" | "ninguna"; miniatura?: boolean }> = {
  "acct-ad-1": { title: "Corte + barba 2x1", body: "Solo esta semana: llega con un amigo y paga uno.", imagen: "normal" },
  "acct-ad-2": { title: "Promo de lunes", body: "Texto largo\ncon salto de línea.", imagen: "grande", miniatura: true },
  "acct-ad-3": { imagen: "normal" },
  "acct-ad-4": { title: "Anuncio pausado", body: "Esta campaña está en pausa.", imagen: "normal" },
  "acct-ad-5": { imagen: "ninguna" },
};

function creativoDeAnuncio(id: string, origen: string) {
  const c = CREATIVOS[id] ?? { title: `Titular ${id}`, body: "Texto del anuncio", imagen: "ninguna" as const, miniatura: true };
  const url = (tipo: string) => `${origen}/api/dev/wa-mock/graph/creative/${tipo}-${id}.png`;
  return {
    id: `creative-${id}`,
    ...(c.title ? { title: c.title } : {}),
    ...(c.body ? { body: c.body } : {}),
    ...(c.imagen && c.imagen !== "ninguna" ? { image_url: url(c.imagen === "grande" ? "big" : "img") } : {}),
    ...(c.imagen !== "ninguna" || c.miniatura ? { thumbnail_url: url("thumb") } : {}),
  };
}

/** Un PNG RGB válido: color sólido con un degradado, o ruido incompresible si se pide pesado. */
function pngDePrueba(id: string, ancho: number, alto: number, pesado: boolean): Buffer {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const r0 = 60 + (h % 150);
  const g0 = 60 + ((h >> 8) % 150);
  const b0 = 60 + ((h >> 16) % 150);
  const filas: Buffer[] = [];
  for (let y = 0; y < alto; y++) {
    const fila = Buffer.alloc(1 + ancho * 3);
    for (let x = 0; x < ancho; x++) {
      const o = 1 + x * 3;
      if (pesado) {
        fila[o] = (Math.imul(x + 1, 2654435761) ^ Math.imul(y + 7, 40503)) & 255;
        fila[o + 1] = (Math.imul(x + 13, 2246822519) ^ Math.imul(y + 3, 3266489917)) & 255;
        fila[o + 2] = (Math.imul(x + 5, 668265263) ^ Math.imul(y + 11, 374761393)) & 255;
      } else {
        const k = Math.floor((y / alto) * 70);
        fila[o] = Math.min(255, r0 + k);
        fila[o + 1] = Math.min(255, g0 + k);
        fila[o + 2] = Math.min(255, b0 - (k >> 1));
      }
    }
    filas.push(fila);
  }
  const trozo = (tipo: string, datos: Buffer) => {
    const largo = Buffer.alloc(4);
    largo.writeUInt32BE(datos.length);
    const cuerpo = Buffer.concat([Buffer.from(tipo, "ascii"), datos]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(cuerpo) >>> 0);
    return Buffer.concat([largo, cuerpo, sum]);
  };
  const cab = Buffer.alloc(13);
  cab.writeUInt32BE(ancho, 0);
  cab.writeUInt32BE(alto, 4);
  cab[8] = 8; // 8 bits
  cab[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo("IHDR", cab),
    trozo("IDAT", deflateSync(Buffer.concat(filas), { level: pesado ? 0 : 6 })),
    trozo("IEND", Buffer.alloc(0)),
  ]);
}

/** `GET …/graph/creative/<tipo>-<id>.png`: lo que sirve el «CDN» del mock (sin token, como el de Meta). */
function handleCreativeImage(path: string[]): Response | null {
  if (path[0] !== "creative" || !path[1]) return null;
  const m = /^(img|thumb|big)-(.+)\.png$/.exec(path[1]);
  if (!m) return new Response("no encontrado", { status: 404 });
  const [, tipo, id] = m;
  const png =
    tipo === "big" ? pngDePrueba(id!, 260, 400, true) : tipo === "thumb" ? pngDePrueba(id!, 64, 64, false) : pngDePrueba(id!, 480, 480, false);
  return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "no-store" } });
}

async function handleMarketing(path: string[], req: Request, token: string): Promise<Response | null> {
  if (!path[0]?.startsWith("act_")) return null;
  const fail = marketingFailure(token);
  if (fail) return fail;
  const headers = marketingHeaders(token);
  const url = new URL(req.url);

  if (path.length === 1) {
    return Response.json(
      { id: path[0], name: "Cuenta publicitaria de prueba", currency: "MXN", account_status: 1, timezone_name: "America/Mexico_City" },
      { headers }
    );
  }
  if (path[1] === "adspixels") {
    return Response.json(
      { data: [{ id: "1708105527110154", name: "Dataset de prueba" }, { id: "2200000000000001", name: "Píxel de la tienda" }] },
      { headers }
    );
  }
  if (path[1] === "ads") {
    const filtrados = idsDelFiltro(url);
    if (filtrados.length > 0) {
      // Consulta suelta por ids (038): solo existen los que no son `gone-*`.
      const data = filtrados.filter((id) => !id.startsWith("gone-")).map(mockAd);
      return Response.json({ data }, { headers });
    }
    // Listado de TODA la cuenta (039); con `creative{…}` en los campos (040) trae también el creativo y el enlace.
    const conCreativo = (url.searchParams.get("fields") ?? "").includes("creative{");
    if (conCreativo && token.endsWith("-sincreativo")) {
      return Response.json(
        { error: { message: "Please reduce the amount of data you're asking for, then retry your request", type: "OAuthException", code: 1, fbtrace_id: "mock" } },
        { status: 500 }
      );
    }
    const origen = new URL(req.url).origin;
    const data = (await universoDeLaCuenta())
      .filter((a) => a.listado)
      .map((a) => ({
        id: a.id,
        name: a.name,
        effective_status: a.status,
        adset: a.adset,
        campaign: a.campaign,
        ...(conCreativo ? { preview_shareable_link: `https://fb.me/mock-${a.id}`, creative: creativoDeAnuncio(a.id, origen) } : {}),
      }));
    return Response.json({ data }, { headers });
  }
  if (path[1] === "insights") {
    let range: { since?: string; until?: string } = {};
    try {
      range = JSON.parse(url.searchParams.get("time_range") ?? "{}") as typeof range;
    } catch {
      // sin rango: no hay filas
    }
    const days = range.since && range.until ? diasEntre(range.since, range.until) : [];
    const level = url.searchParams.get("level");
    const ids = idsDelFiltro(url);

    // Con filtro de ids (038) solo esos; sin filtro (039), la cuenta entera.
    const universo = ids.length > 0 ? ids.filter((id) => !id.startsWith("gone-")).map((id) => mockAd(id)) : null;
    const anuncios = universo
      ? universo.map((m) => ({ id: m.id, name: m.name, adset: m.adset, campaign: m.campaign, gasto: 10 + (Number(m.id.match(/(\d+)$/)?.[1] ?? 0) % 5) + 0.5 }))
      : (await universoDeLaCuenta()).filter((a) => a.gasto !== null).map((a) => ({ id: a.id, name: a.name, adset: a.adset, campaign: a.campaign, gasto: a.gasto as number }));

    if (level === "account") {
      const extra = token.endsWith("-descuadre") ? 3.25 : 0;
      const data = days.map((d) => ({
        spend: (anuncios.reduce((t, a) => t + a.gasto, 0) + extra).toFixed(2),
        account_currency: "MXN",
        date_start: d,
        date_stop: d,
      }));
      return Response.json({ data }, { headers });
    }
    const data = anuncios.flatMap((a) =>
      days.map((d) => ({
        ad_id: a.id,
        ad_name: a.name,
        adset_id: a.adset.id,
        adset_name: a.adset.name,
        campaign_id: a.campaign.id,
        campaign_name: a.campaign.name,
        spend: a.gasto.toFixed(2),
        account_currency: "MXN",
        date_start: d,
        date_stop: d,
      }))
    );
    return Response.json({ data }, { headers });
  }
  return Response.json({ data: [] }, { headers });
}

export async function GET(req: Request, ctx: Params) {
  const guard = mockGuard();
  if (guard) return guard;
  const path = normalizePath((await ctx.params).path);
  // 040 — Las imágenes de los creativos las sirve un «CDN» sin token, como el de Meta.
  const imagen = handleCreativeImage(path);
  if (imagen) return imagen;
  const token = bearerToken(req);
  if (token.endsWith("-invalid")) return invalidTokenResponse();

  // 038 — Marketing API (cuenta publicitaria, anuncios, gasto).
  const marketing = await handleMarketing(path, req, token);
  if (marketing) return marketing;

  // GET {wabaId}/message_templates → lista para el sync
  if (path.length === 2 && path[1] === "message_templates") {
    const state = getWaMockState();
    return Response.json({
      data: state.templates.map((t) => ({
        id: t.id,
        name: t.name,
        language: t.language,
        category: t.category,
        status: t.status,
        components: t.components ?? [{ type: "BODY", text: t.body }],
      })),
    });
  }

  // GET {wabaId}/subscribed_apps → la app suscrita y, si lo hay, su override
  // de callback. Misma forma que Meta; sin suscripción, `data` vacío.
  if (path.length === 2 && path[1] === "subscribed_apps") {
    const sub = getWaMockState().wabaSubscriptions[path[0]!];
    return Response.json({
      data: sub
        ? [
            {
              whatsapp_business_api_data: MOCK_APP,
              ...(sub.overrideCallbackUri
                ? { override_callback_uri: sub.overrideCallbackUri }
                : {}),
            },
          ]
        : [],
    });
  }

  // GET {mediaId} (ids "media...") → metadata de adjunto (media proxy del bot)
  if (path.length === 1 && path[0]!.startsWith("media")) {
    const origin = new URL(req.url).origin;
    return Response.json({
      id: path[0],
      mime_type: path[0]!.includes("pdf") ? "application/pdf" : "image/jpeg",
      file_size: 13,
      url: `${origin}/api/dev/wa-mock/media-file/${path[0]}`,
    });
  }

  // 017 — GET {psid}?fields=first_name,last_name → perfil de quien escribe
  // por Messenger (la ingesta lo consulta la primera vez que ve un PSID).
  const fields = new URL(req.url).searchParams.get("fields") ?? "";

  // GET {phoneNumberId}?fields=webhook_configuration → el override vigente
  // del número y la callback URL de la app (ausente con un token "-sin-app").
  if (path.length === 1 && fields.includes("webhook_configuration")) {
    const override = getWaMockState().phoneWebhooks[path[0]!];
    return Response.json({
      webhook_configuration: {
        ...(override ? { phone_number: override } : {}),
        ...(token.endsWith(SIN_WEBHOOK_DE_APP)
          ? {}
          : { application: "https://app-de-meta.mock/webhook" }),
      },
      id: path[0],
    });
  }

  if (path.length === 1 && fields.includes("first_name")) {
    return Response.json({
      id: path[0],
      first_name: "Cliente",
      last_name: "de Messenger",
    });
  }

  // 017 — GET {pageId}?fields=id,name → validación de la página de Facebook
  if (path.length === 1 && /(^|,)name(,|$)/.test(fields)) {
    return Response.json({ id: path[0], name: "Página de prueba Vocero" });
  }

  // GET {phoneNumberId}?fields=... → validación del wizard
  if (path.length === 1) {
    return Response.json({
      display_phone_number: "+52 55 0000 0000",
      verified_name: "Número de prueba Vocero",
      id: path[0],
    });
  }

  return Response.json({});
}

export async function POST(req: Request, ctx: Params) {
  const guard = mockGuard();
  if (guard) return guard;
  const path = normalizePath((await ctx.params).path);
  const token = bearerToken(req);
  if (token.endsWith("-invalid")) return invalidTokenResponse();

  // POST {phoneNumberId}/media (multipart, 008) → id de media subido.
  // Va ANTES del parseo JSON: el body es form-data.
  if (path.length === 2 && path[1] === "media") {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof Blob)) {
      return Response.json(
        { error: { message: "missing file", type: "GraphMethodException", code: 100 } },
        { status: 400 }
      );
    }
    // El id arranca con "media" para que el GET de metadata lo resuelva.
    return Response.json({ id: `media-up-${nextN()}` });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // 016 — POST {datasetId}/events: Conversions API. Imita las tres cosas que
  // de verdad importan del endpoint real: el catálogo cerrado de nombres, la
  // exigencia del ctwa_clid, y —sobre todo— que Meta puede responder 200
  // DESCARTANDO el evento. Los datasets terminados en "-fail" reproducen eso
  // último, que es el modo de fallo que nadie ve venir.
  if (path.length === 2 && path[1] === "events") {
    const state = getWaMockState();
    const events = Array.isArray(body.data)
      ? (body.data as Record<string, unknown>[])
      : [];
    const event = events[0];
    const eventName = String(event?.event_name ?? "");
    const userData = (event?.user_data ?? {}) as Record<string, unknown>;
    const ctwaClid = userData.ctwa_clid ? String(userData.ctwa_clid) : null;

    if (!CAPI_EVENT_NAMES.has(eventName)) {
      return Response.json(
        {
          error: {
            message: `(#100) Invalid parameter: event_name ${eventName || "(vacío)"}`,
            type: "GraphMethodException",
            code: 100,
            fbtrace_id: "mock-capi-badname",
          },
        },
        { status: 400 }
      );
    }
    if (!ctwaClid) {
      return Response.json(
        {
          error: {
            message: "Messaging Event Invalid Ctwa Clid",
            type: "GraphMethodException",
            code: 100,
            error_subcode: 2804087,
            fbtrace_id: "mock-capi-noclid",
          },
        },
        { status: 400 }
      );
    }

    const datasetId = path[0]!;
    state.capiEvents.push({
      n: nextN(),
      datasetId,
      eventName,
      ctwaClid,
      customData:
        (event?.custom_data as Record<string, unknown> | undefined) ?? null,
      body,
      at: new Date().toISOString(),
    });

    // El 200 mentiroso: recibido por HTTP, descartado por Meta.
    const received = datasetId.endsWith("-fail") ? 0 : 1;
    return Response.json({
      events_received: received,
      messages: [],
      fbtrace_id: `mock-capi-${state.capiEvents.length}`,
    });
  }

  // POST {phoneNumberId}/messages con status:"read" → typing/leído:
  // NO es un mensaje saliente — no contamina el outbox.
  if (path.length === 2 && path[1] === "messages" && body.status === "read") {
    return Response.json({ success: true });
  }

  // POST {phoneNumberId}/messages → registra en el outbox
  if (path.length === 2 && path[1] === "messages") {
    const state = getWaMockState();

    /**
     * Meta espera un TELEFONO en `to`. Un BSUID ahi devuelve 131026 — «el
     * destinatario no puede recibir mensajes» — y el mock lo replica.
     *
     * Sin esto, mandar el BSUID en el campo equivocado pasaba en verde aqui y
     * fallaba en produccion, que es exactamente lo que ocurrio. El BSUID va
     * en `recipient`, con `recipient_type: "individual"`.
     */
    const destino = body.to as string | undefined;
    if (destino && !esSoloDigitos(destino)) {
      return Response.json(
        {
          error: {
            message:
              "(#131026) Message undeliverable: recipient is not a valid WhatsApp user",
            code: 131026,
            type: "OAuthException",
          },
        },
        { status: 400 }
      );
    }
    // Meta responde 132000 si los parámetros no cuadran con las {{n}} de la
    // plantilla aprobada. El mock lo replica para que un desfase no pase.
    if (body.type === "template") {
      const tplSend = body.template as
        | {
            name?: string;
            components?: { type?: string; parameters?: unknown[] }[];
          }
        | undefined;
      const known = state.templates.find((t) => t.name === tplSend?.name);
      if (known) {
        const expected = [...known.body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].reduce(
          (max, m) => Math.max(max, Number(m[1])),
          0
        );
        const got =
          tplSend?.components?.find(
            (c) => (c.type ?? "").toLowerCase() === "body"
          )?.parameters?.length ?? 0;
        if (expected !== got) {
          return Response.json(
            {
              error: {
                message: `(#132000) Number of parameters does not match the expected number of params: expected ${expected}, got ${got}`,
                type: "OAuthException",
                code: 132000,
                fbtrace_id: "mock",
              },
            },
            { status: 400 }
          );
        }
      }
    }
    const n = nextN();
    const waMessageId = nextOutboundWamid();
    state.outbox.push({
      n,
      waMessageId,
      phoneNumberId: path[0]!,
      to: String(body.to ?? ""),
      // Se guarda aparte para que un self-test pueda comprobar EN QUE CAMPO
      // viajo el destinatario, que es de lo que dependia el fallo.
      ...(body.recipient ? { recipient: String(body.recipient) } : {}),
      type: String(body.type ?? "text"),
      body,
      at: new Date().toISOString(),
    });
    return Response.json({
      messaging_product: "whatsapp",
      contacts: [{ input: body.to, wa_id: body.to }],
      messages: [{ id: waMessageId }],
    });
  }

  // POST {wabaId}/message_templates → alta de plantilla (queda PENDING)
  if (path.length === 2 && path[1] === "message_templates") {
    const state = getWaMockState();
    const components = (body.components ?? []) as {
      type?: string;
      text?: string;
      example?: { body_text?: string[][] };
    }[];
    const bodyComponent = components.find(
      (c) => (c.type ?? "").toUpperCase() === "BODY"
    );
    // Meta valida que haya un ejemplo por cada {{n}} del cuerpo: sin esto el
    // mock aceptaría plantillas que producción rechaza (error 100).
    const highestVar = [
      ...(bodyComponent?.text ?? "").matchAll(/\{\{\s*(\d+)\s*\}\}/g),
    ].reduce((max, m) => Math.max(max, Number(m[1])), 0);
    const examples = bodyComponent?.example?.body_text?.[0] ?? [];
    if (highestVar !== examples.length) {
      return Response.json(
        {
          error: {
            message: `Invalid parameter: expected ${highestVar} example value(s) for the body, got ${examples.length}`,
            type: "GraphMethodException",
            code: 100,
            fbtrace_id: "mock",
          },
        },
        { status: 400 }
      );
    }
    const tpl: MockTemplate = {
      id: `tplmock_${nextN()}`,
      name: String(body.name ?? ""),
      language: String(body.language ?? "es_MX"),
      category: String(body.category ?? "UTILITY"),
      status: "PENDING",
      body: bodyComponent?.text ?? "",
      components,
    };
    state.templates.push(tpl);
    return Response.json({ id: tpl.id, status: "PENDING", category: tpl.category });
  }

  // POST {wabaId}/subscribed_apps → suscribe la app. Como en Meta, el override
  // de callback se fija mandándolo en el cuerpo y un POST SIN él lo BORRA
  // ("Delete WABA alternate callback"): un CRM que re-suscribe a ciegas
  // desconecta aquí al cerebro externo igual que en producción.
  if (path.length === 2 && path[1] === "subscribed_apps") {
    if (token.endsWith(SIN_GESTION)) return permissionErrorResponse();
    const uri =
      typeof body.override_callback_uri === "string"
        ? body.override_callback_uri.trim()
        : "";
    getWaMockState().wabaSubscriptions[path[0]!] = {
      overrideCallbackUri: uri || null,
    };
    return Response.json({ success: true });
  }

  // POST {phoneNumberId} con webhook_configuration → override del NÚMERO, el
  // que el CRM registra al guardar la conexión. Como en Meta: exige el
  // permiso de gestión, verifica el callback (handshake) antes de aceptarlo y
  // una cadena vacía lo quita.
  if (path.length === 1 && body.webhook_configuration) {
    if (token.endsWith(SIN_GESTION)) return permissionErrorResponse();
    const config = body.webhook_configuration as {
      override_callback_uri?: string;
      verify_token?: string;
    };
    const state = getWaMockState();
    const uri = config.override_callback_uri ?? "";
    if (!uri) {
      delete state.phoneWebhooks[path[0]!];
      return Response.json({ success: true });
    }
    const failure = await callbackVerificationError(uri, config.verify_token ?? "");
    if (failure) return callbackVerificationFailed(failure);
    state.phoneWebhooks[path[0]!] = uri;
    return Response.json({ success: true });
  }

  return Response.json({});
}

export async function DELETE(req: Request, ctx: Params) {
  const guard = mockGuard();
  if (guard) return guard;
  const token = bearerToken(req);
  if (token.endsWith("-invalid")) return invalidTokenResponse();
  await ctx.params;
  return Response.json({ success: true });
}
