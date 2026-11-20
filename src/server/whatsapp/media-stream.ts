import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

export type ByteRange = { start: number; end: number };

/**
 * `Range: bytes=a-b` → rango inclusivo; "invalid" si no es satisfacible;
 * null si no hay Range utilizable (se sirve completo).
 */
export function parseByteRange(
  header: string | null,
  size: number
): ByteRange | "invalid" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // varios rangos u otro formato: se sirve completo
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  if (size === 0) return "invalid";
  let start: number;
  let end: number;
  if (a === "") {
    const n = Number(b);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

/**
 * Sirve un archivo del disco por tramos: la memoria no depende del tamaño
 * (antes se leia entero con readFile y un video de 76 MB tumbaba la instancia).
 */
export async function serveFileStream(
  req: Request,
  filePath: string,
  baseHeaders: Record<string, string>
): Promise<Response> {
  const { size } = await stat(filePath);
  const headers: Record<string, string> = { ...baseHeaders, "accept-ranges": "bytes" };
  const range = parseByteRange(req.headers.get("range"), size);
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-length": "0", "content-range": `bytes */${size}` },
    });
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  headers["content-length"] = String(size === 0 ? 0 : end - start + 1);
  if (range) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  if (size === 0) return new Response(null, { status: 200, headers });
  const body = Readable.toWeb(
    createReadStream(filePath, { start, end })
  ) as unknown as ReadableStream;
  return new Response(body, { status: range ? 206 : 200, headers });
}
