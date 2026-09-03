import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {getTableName} from 'drizzle-orm';
import {mvpTables} from './schema.ts';

const expected = [
  'workspaces', 'actors', 'oauth_login_attempts', 'operator_sessions', 'projects',
  'project_memberships', 'actor_external_identities', 'project_source_artifacts',
  'secret_refs', 'tracker_bindings', 'tracker_snapshots', 'incoming_events',
  'approval_evidence', 'command_receipts', 'outbox_events', 'audit_events'
];
const sql = readFileSync(fileURLToPath(new URL('../../mvp-drizzle/0000_mvp.sql', import.meta.url)), 'utf8');
const cleanup = readFileSync(fileURLToPath(
  new URL('../../mvp-drizzle/0001_remove_legacy_agent_outbox.sql', import.meta.url)), 'utf8');
const artifactIdentity = readFileSync(fileURLToPath(
  new URL('../../mvp-drizzle/0002_source_artifact_kind_identity.sql', import.meta.url)), 'utf8');
const attemptLifecycle = readFileSync(fileURLToPath(
  new URL('../../mvp-drizzle/0003_agent_attempt_lifecycle_index.sql', import.meta.url)), 'utf8');
const binaryArtifact = readFileSync(fileURLToPath(
  new URL('../../mvp-drizzle/0004_source_artifact_binary_payload.sql', import.meta.url)), 'utf8');
const confirmedProcess = readFileSync(fileURLToPath(
  new URL('../../mvp-drizzle/0005_activate_confirmed_process.sql', import.meta.url)), 'utf8');

describe('MVP fresh schema', () => {
  it('declares exactly the approved 16 tables', () => {
    expect(Object.values(mvpTables).map(getTableName)).toEqual(expected);
    expect([...sql.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1])).toEqual(expected);
  });

  it.each(['work_items', 'agent_runs', 'task_packets', 'project_executions', 'deployment_jobs',
    'risk_signals', 'conversation_messages', 'resource_access_grants'])('contains no legacy table %s', (name) => {
    expect(sql).not.toContain(`"${name}"`);
  });

  it('contains no destructive or history migration operation', () => {
    expect(sql).not.toMatch(/\b(?:DROP|ALTER|DELETE|TRUNCATE)\b/i);
  });

  it('removes only the approved legacy agent outbox topic in the forward cleanup', () => {
    expect(cleanup).toContain(`DELETE FROM "outbox_events" WHERE "topic" = 'agent-role-request'`);
    expect(cleanup).toContain(`CHECK ("topic" = 'messenger-notification')`);
    expect(cleanup).not.toMatch(/DROP\s+(?:TABLE|TYPE)|CASCADE|TRUNCATE|project_|tracker_|audit_/i);
    expect(sql).not.toContain('agent-role-request');
  });

  it('keeps snapshot binding and provider inbox identities distinct', () => {
    expect(sql).toMatch(/CREATE TABLE "tracker_snapshots"[\s\S]*?"binding_id" uuid NOT NULL REFERENCES "tracker_bindings"/);
    expect(sql).toMatch(/CREATE TABLE "incoming_events"[\s\S]*?"project_id" uuid NOT NULL REFERENCES "projects"[\s\S]*?"provider" text NOT NULL/);
  });

  it('identifies immutable artifacts by project, semantic kind and content hash', () => {
    expect(sql).toContain('"project_source_artifacts_kind_hash_unique" UNIQUE ("project_id", "kind", "sha256")');
    expect(artifactIdentity).toContain('("project_id", "kind", "sha256")');
    expect(artifactIdentity).not.toMatch(/DROP\s+(?:TABLE|TYPE)|CASCADE|TRUNCATE|DELETE/i);
  });

  it('adds bounded binary originals to the existing artifact table without a seventeenth table',()=>{
    expect(binaryArtifact).toContain('"content_bytes" bytea');
    expect(binaryArtifact).toContain('52428800');
    expect(binaryArtifact).not.toMatch(/CREATE\s+TABLE|DROP\s+TABLE|DELETE|TRUNCATE|CASCADE/i);
    expect(sql).toContain('"size_bytes" bigint GENERATED ALWAYS');
  });

  it('stores references and hashes, not secret values or chat transcripts', () => {
    expect(expected).toContain('secret_refs');
    expect(expected).not.toContain('secrets');
    expect(sql).not.toMatch(/message_body|chat_history|secret_value|storage_reference|action_payload|processed_at/i);
  });

  it('indexes append-only attempt lifecycle facts without introducing a run table', () => {
    expect(attemptLifecycle).toContain('CREATE INDEX IF NOT EXISTS "audit_events_attempt_lifecycle_idx"');
    expect(attemptLifecycle).not.toMatch(/CREATE\s+TABLE|DROP|DELETE|TRUNCATE/i);
    expect(sql).not.toContain('CREATE TABLE "agent_run');
  });

  it('activates an existing process when an older wizard confirmation lacks activation',()=>{
    expect(confirmedProcess).toContain("project.wizard.process-confirm");
    expect(confirmedProcess).toContain("project.process.configure");
    expect(confirmedProcess).toContain("wizard-process:");
    expect(confirmedProcess).not.toMatch(/\b(?:UPDATE|DELETE|DROP|TRUNCATE)\b/i);
  });
});
