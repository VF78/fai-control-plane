ALTER TABLE "project_source_artifacts"
  ADD COLUMN IF NOT EXISTS "content_bytes" bytea;

ALTER TABLE "project_source_artifacts"
  ALTER COLUMN "content_text" DROP NOT NULL;

ALTER TABLE "project_source_artifacts"
  ADD COLUMN IF NOT EXISTS "size_bytes" bigint
    GENERATED ALWAYS AS (coalesce(octet_length("content_bytes"), octet_length("content_text"))) STORED,
  ADD CONSTRAINT "project_source_artifacts_payload_check"
    CHECK (
      ("content_text" IS NOT NULL AND "content_bytes" IS NULL) OR
      ("content_text" IS NULL AND "content_bytes" IS NOT NULL AND octet_length("content_bytes") BETWEEN 1 AND 52428800)
    );
