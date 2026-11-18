import { r2Config, r2Incompleto } from "@/server/storage/config";
import { objectStore } from "@/server/storage";

/** 048 — ¿Se puede hablar con el bucket? Un HEAD de una clave que no existe: «no existe» es éxito, un error de credenciales no. */
export type R2Health = { status: "off" | "incomplete" | "ok" | "fail"; bucket?: string; detail?: string };

export async function probeR2(): Promise<R2Health> {
  if (r2Incompleto()) return { status: "incomplete", detail: "R2_STORAGE=on pero falta alguna variable R2_*" };
  const cfg = r2Config();
  const store = objectStore();
  if (!cfg || !store) return { status: "off" };
  try {
    await store.head("__doctor__/no-existe");
    return { status: "ok", bucket: cfg.bucket };
  } catch (err) {
    return { status: "fail", bucket: cfg.bucket, detail: err instanceof Error ? err.message : "error" };
  }
}
