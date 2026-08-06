-- Seed the approved #91 baseline only for projects that have no prior scope version.
-- Existing and future baselines remain immutable migration inputs.
WITH inserted_baselines AS (
  INSERT INTO "project_scope_baseline_versions" (
    "project_id", "version", "active", "approved_by_actor_id", "approved_at",
    "checkpoint_title", "checkpoint_status", "checkpoint_owner_actor_id", "checkpoint_target_at"
  )
  SELECT
    "projects"."id",
    1,
    true,
    "owner"."actor_id",
    now(),
    CASE "projects"."slug"
      WHEN 'msa' THEN 'Совместный E2E-сценарий и бизнес-приёмка'
      ELSE 'Подтвердить старт работ'
    END,
    CASE "projects"."slug"
      WHEN 'msa' THEN 'in_dev'::"work_item_status"
      ELSE 'ready'::"work_item_status"
    END,
    "owner"."actor_id",
    NULL
  FROM "projects"
  LEFT JOIN LATERAL (
    SELECT "project_memberships"."actor_id"
    FROM "project_memberships"
    WHERE "project_memberships"."project_id" = "projects"."id"
      AND "project_memberships"."active" = true
      AND "project_memberships"."role" = 'project_owner'
    ORDER BY "project_memberships"."actor_id"
    LIMIT 1
  ) AS "owner" ON true
  WHERE "projects"."slug" IN ('msa', 'ascon')
    AND NOT EXISTS (
      SELECT 1 FROM "project_scope_baseline_versions"
      WHERE "project_scope_baseline_versions"."project_id" = "projects"."id"
        AND "project_scope_baseline_versions"."version" = 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM "project_scope_baseline_versions"
      WHERE "project_scope_baseline_versions"."project_id" = "projects"."id"
    )
  RETURNING "id", "project_id", "approved_by_actor_id", "approved_at"
), inserted_outcomes AS (
  INSERT INTO "project_scope_outcomes" (
    "baseline_id", "key", "title", "weight", "state", "accepted_by_actor_id", "accepted_at", "evidence_reference"
  )
  SELECT
    "inserted_baselines"."id",
    "outcomes"."key",
    "outcomes"."title",
    "outcomes"."weight",
    "outcomes"."state",
    CASE WHEN "outcomes"."state" = 'accepted'::"scope_outcome_state" THEN "inserted_baselines"."approved_by_actor_id" ELSE NULL END,
    CASE WHEN "outcomes"."state" = 'accepted'::"scope_outcome_state" THEN "inserted_baselines"."approved_at" ELSE NULL END,
    'Решение Product Owner · #91'
  FROM "inserted_baselines"
  INNER JOIN "projects" ON "projects"."id" = "inserted_baselines"."project_id"
  CROSS JOIN LATERAL (
    VALUES
      ('msa', 'foundation', 'Фундамент решения', 5, 'accepted'::"scope_outcome_state"),
      ('msa', 'matching', 'Сопоставление номенклатуры', 20, 'accepted'::"scope_outcome_state"),
      ('msa', 'documents_ocr', 'Документы и OCR', 20, 'accepted'::"scope_outcome_state"),
      ('msa', 'onec_api', 'Интеграция 1С и API', 20, 'review'::"scope_outcome_state"),
      ('msa', 'feedback', 'Обратная связь', 10, 'in_progress'::"scope_outcome_state"),
      ('msa', 'security', 'Безопасность', 10, 'in_progress'::"scope_outcome_state"),
      ('msa', 'e2e', 'Совместный E2E-сценарий', 10, 'in_progress'::"scope_outcome_state"),
      ('msa', 'release', 'Выпуск', 5, 'not_started'::"scope_outcome_state"),
      ('ascon', 'context', 'Контекст проекта', 5, 'not_started'::"scope_outcome_state"),
      ('ascon', 'contract', 'Контракт и границы', 5, 'not_started'::"scope_outcome_state"),
      ('ascon', 'foundation_cloud', 'Фундамент и облачный контур', 15, 'not_started'::"scope_outcome_state"),
      ('ascon', 'api', 'API', 10, 'not_started'::"scope_outcome_state"),
      ('ascon', 'roi_rag', 'ROI и RAG', 30, 'not_started'::"scope_outcome_state"),
      ('ascon', 'quality', 'Качество', 15, 'not_started'::"scope_outcome_state"),
      ('ascon', 'integration', 'Интеграция', 10, 'not_started'::"scope_outcome_state"),
      ('ascon', 'acceptance', 'Приёмка', 10, 'not_started'::"scope_outcome_state")
  ) AS "outcomes" ("project_slug", "key", "title", "weight", "state")
  WHERE "outcomes"."project_slug" = "projects"."slug"
  RETURNING "baseline_id"
)
INSERT INTO "project_scope_outcome_observations" (
  "project_id", "baseline_id", "accepted_weight", "total_weight", "observed_at", "evidence_reference"
)
SELECT
  "inserted_baselines"."project_id",
  "inserted_baselines"."id",
  CASE "projects"."slug" WHEN 'msa' THEN 45 ELSE 0 END,
  100,
  now(),
  'Решение Product Owner · #91'
FROM "inserted_baselines"
INNER JOIN "projects" ON "projects"."id" = "inserted_baselines"."project_id"
CROSS JOIN (SELECT count(*) FROM "inserted_outcomes") AS "outcome_write";
