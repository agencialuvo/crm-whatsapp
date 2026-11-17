import { computeMetrics, type Metrics } from "@/lib/saas";
import { loadConversionEvents, loadOrganizations } from "@/server/super-admin/directory";

/**
 * 045 — El dashboard del Super Admin: lee todas las organizaciones y la historia de conversión, y delega todo
 * el cálculo en `computeMetrics` (pura, probada con tablas de casos). Aquí no hay aritmética.
 */
export async function loadMetrics(now = new Date()): Promise<Metrics> {
  const [orgs, events] = await Promise.all([loadOrganizations(), loadConversionEvents()]);
  return computeMetrics(orgs, events, now);
}
