DROP INDEX "lead_org_stage_idx";--> statement-breakpoint
ALTER TABLE "lead_stage_event" ADD COLUMN "auto_rule" text;--> statement-breakpoint
ALTER TABLE "pipeline_stage" ADD COLUMN "auto_role" text;--> statement-breakpoint
CREATE INDEX "lead_board_idx" ON "lead" USING btree ("organization_id","stage_id","position","id");--> statement-breakpoint
CREATE INDEX "lead_org_updated_idx" ON "lead" USING btree ("organization_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stage_org_auto_role_uq" ON "pipeline_stage" USING btree ("organization_id","auto_role") WHERE "pipeline_stage"."auto_role" is not null;
-- 044: roles de etapa para el avance automático. Solo se asigna cuando la equivalencia por nombre es
-- INEQUÍVOCA en esa organización (exactamente una etapa coincide); si no, queda en NULL y la asigna el dueño.
UPDATE "pipeline_stage" s SET "auto_role" = c.role
FROM (
  SELECT organization_id, role, (array_agg(id))[1] AS id
  FROM (
    SELECT organization_id, id,
      CASE
        WHEN kind = 'open' AND lower(name) = 'nuevo' THEN 'new'
        WHEN kind = 'open' AND lower(name) IN ('en conversación', 'en conversacion', 'contactado') THEN 'conversation'
        WHEN kind = 'open' AND lower(name) IN ('interesado', 'citado') THEN 'interested'
        WHEN kind = 'won' AND lower(name) IN ('cliente', 'convertido') THEN 'client'
      END AS role
    FROM "pipeline_stage"
  ) x
  WHERE role IS NOT NULL
  GROUP BY organization_id, role
  HAVING count(*) = 1
) c
WHERE s.id = c.id;--> statement-breakpoint

-- 044: posiciones contiguas 0..n-1 por columna (hasta hoy el cliente las calculaba y podían empatar).
UPDATE "lead" l SET "position" = r.rn
FROM (
  SELECT id, (row_number() OVER (PARTITION BY stage_id ORDER BY position, id) - 1)::int AS rn FROM "lead"
) r
WHERE l.id = r.id AND l."position" IS DISTINCT FROM r.rn;
