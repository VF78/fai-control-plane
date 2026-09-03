WITH confirmed AS (
  SELECT DISTINCT ON (r.project_id)
    r.project_id, r.actor_id, r.occurred_at, p.workspace_id
  FROM command_receipts r
  JOIN projects p ON p.id = r.project_id
  WHERE r.command_type = 'project.wizard.process-confirm'
  ORDER BY r.project_id, r.occurred_at DESC, r.id DESC
), targets AS (
  SELECT c.*, s.id AS policy_id, s.sha256
  FROM confirmed c
  JOIN LATERAL (
    SELECT id, sha256
    FROM project_source_artifacts
    WHERE project_id = c.project_id AND kind = 'project_process_policy_v1'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  ) s ON true
  WHERE NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.project_id = c.project_id AND a.action = 'project.process.configure'
  )
)
INSERT INTO command_receipts(project_id,actor_id,idempotency_key,command_type,result_reference,occurred_at)
SELECT project_id,actor_id,'wizard-process:' || project_id::text,'project.process.configure',policy_id::text,occurred_at
FROM targets
ON CONFLICT(idempotency_key) DO NOTHING;

WITH confirmed AS (
  SELECT DISTINCT ON (r.project_id)
    r.project_id, r.actor_id, r.occurred_at, p.workspace_id
  FROM command_receipts r
  JOIN projects p ON p.id = r.project_id
  WHERE r.command_type = 'project.wizard.process-confirm'
  ORDER BY r.project_id, r.occurred_at DESC, r.id DESC
), targets AS (
  SELECT c.*, s.id AS policy_id, s.sha256
  FROM confirmed c
  JOIN LATERAL (
    SELECT id, sha256
    FROM project_source_artifacts
    WHERE project_id = c.project_id AND kind = 'project_process_policy_v1'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  ) s ON true
  WHERE NOT EXISTS (
    SELECT 1 FROM audit_events a
    WHERE a.project_id = c.project_id AND a.action = 'project.process.configure'
  )
)
INSERT INTO audit_events(workspace_id,project_id,actor_id,action,target_reference,correlation_id,details,occurred_at)
SELECT workspace_id,project_id,actor_id,'project.process.configure',policy_id::text,
  'migration:0005:activate-confirmed-process:' || project_id::text,
  jsonb_build_object('version',sha256,'backfilled',true),occurred_at
FROM targets;
