CREATE OR REPLACE FUNCTION project_tracker_repository_scope_identity_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR
     NEW.provider IS DISTINCT FROM OLD.provider OR
     NEW.repository_owner IS DISTINCT FROM OLD.repository_owner OR
     NEW.repository_name IS DISTINCT FROM OLD.repository_name OR
     NEW.repository_external_id IS DISTINCT FROM OLD.repository_external_id THEN
    RAISE EXCEPTION 'project_tracker_repository_scope_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;
