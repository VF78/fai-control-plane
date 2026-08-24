ALTER TABLE "project_source_artifacts"
  DROP CONSTRAINT IF EXISTS "project_source_artifacts_hash_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "project_source_artifacts_kind_hash_unique"
  ON "project_source_artifacts" ("project_id", "kind", "sha256");
