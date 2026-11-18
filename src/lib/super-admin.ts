import { z } from "zod";
import { SUB_ACTIONS, type EffectiveStatus, type SubEventType } from "@/lib/saas";
import type { PaymentDto } from "@/server/billing/dto";

/**
 * 045 — Contratos del panel de Super Admin: lo comparten el servidor (rutas) y la UI.
 *
 * MINIMIZACIÓN DE DATOS: el panel es cross-tenant por diseño, así que solo ve METADATOS de la cuenta (quién
 * es, qué plan tiene, en qué estado y desde cuándo). Jamás conversaciones, contactos, mensajes, credenciales ni
 * llaves. Las listas `*_FIELDS` son la lista blanca: una prueba falla si un DTO gana un campo que no está aquí.
 */

const ISO = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

export const subscriptionActionSchema = z.object({
  action: z.enum(SUB_ACTIONS as unknown as [string, ...string[]]),
  /** assign / activate / change_plan / reactivate. */
  planId: z.string().trim().min(1).max(64).optional(),
  /** extend_trial: 1–90 (la regla vive en `decideTransition`). */
  days: z.number().int().optional(),
  /** set_period_end: `AAAA-MM-DD` del DatePicker (o un ISO). */
  periodEnd: z.string().regex(ISO, "Fecha inválida").optional(),
  /** cancel: la suscripción sigue activa hasta el corte. */
  cancelAtPeriodEnd: z.boolean().optional(),
  /** Todo cambio manual deja un motivo. */
  reason: z.string().trim().min(3, "Escribe el motivo (mínimo 3 letras)").max(300, "Máximo 300 caracteres"),
});
export type SubscriptionActionInput = z.infer<typeof subscriptionActionSchema>;

export const organizationsQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  plan: z.string().trim().max(64).optional(),
  status: z.enum(["trialing", "trial_expired", "active", "past_due", "canceled", "paused", "none"]).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(5000),
});

export type PlanDto = {
  id: string;
  name: string;
  slug: string;
  priceMonthlyCents: number;
  currency: string;
  trialDays: number | null;
  active: boolean;
  modules: string[];
};

export type OrganizationRowDto = {
  id: string;
  name: string;
  ownerName: string | null;
  ownerEmail: string | null;
  planId: string | null;
  planName: string | null;
  planActive: boolean | null;
  isTrialPlan: boolean;
  priceMonthlyCents: number | null;
  /** null = la organización no tiene suscripción (anterior al módulo SaaS). */
  status: EffectiveStatus | null;
  statusReason: string | null;
  daysLeft: number | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
  /** 046 — `mercadopago` si la pasarela cobra esta suscripción; null = cobro manual. */
  billingProvider: string | null;
  /** true = la pasarela tiene una suscripción VIGENTE (autorizada/pausada): activar/asignar a mano se bloquea. */
  managedByProvider: boolean;
  mpStatus: string | null;
  lastPaymentAt: string | null;
  nextPaymentAt: string | null;
  pendingPlanName: string | null;
};

export const ORGANIZATION_ROW_FIELDS = [
  "id",
  "name",
  "ownerName",
  "ownerEmail",
  "planId",
  "planName",
  "planActive",
  "isTrialPlan",
  "priceMonthlyCents",
  "status",
  "statusReason",
  "daysLeft",
  "currentPeriodEnd",
  "cancelAtPeriodEnd",
  "createdAt",
  "billingProvider",
  "managedByProvider",
  "mpStatus",
  "lastPaymentAt",
  "nextPaymentAt",
  "pendingPlanName",
] as const;

export type SubscriptionEventDto = {
  id: string;
  type: SubEventType;
  fromStatus: string | null;
  toStatus: string | null;
  fromPlanName: string | null;
  toPlanName: string | null;
  periodEndAfter: string | null;
  source: "signup" | "admin" | "system" | "payment";
  actorName: string | null;
  reason: string | null;
  approximate: boolean;
  occurredAt: string;
};

export type AuditEntryDto = {
  id: string;
  action: string;
  actorEmail: string | null;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
};

export type OrganizationDetailDto = {
  organization: OrganizationRowDto;
  events: SubscriptionEventDto[];
  audit: AuditEntryDto[];
  /** 046 — Cobros de la pasarela (solo metadatos). */
  payments: PaymentDto[];
};

export const AUDIT_ACTIONS = ["grant", "revoke", ...SUB_ACTIONS] as const;
