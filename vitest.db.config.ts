import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Pruebas contra PostgreSQL REAL (`pnpm test:db`): las que terminan en `-live.test.ts`.
 *
 * No corren con `pnpm test` (necesitan una base migrada y se saltan solas sin `RUN_DB_TESTS`). Aquí van
 * con la variable ya puesta —así funciona igual en Windows y en Linux— y SECUENCIALES: comparten la
 * misma base y la cola (`claimDue` toma las tareas vencidas de TODA la base), así que dos archivos a la
 * vez se pisarían las filas.
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/unit/**/*-live.test.ts"],
    environment: "node",
    env: { RUN_DB_TESTS: "1" },
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
});
