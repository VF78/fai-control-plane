import {createHash} from 'node:crypto';
import {canonicalJson, validateDeliveryProtocolDefinition,
  type DeliveryProtocolResponsibility, type ProjectPlanTaskResponsibility} from '@fai-control-plane/domain';
import {and, asc, eq, isNull} from 'drizzle-orm';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import {projectMembershipHasRoleSql} from './project-membership-roles';

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Queryable = Database | Transaction;

export type ResolvedWorkItemResponsibility = Readonly<{
  actor: Readonly<{id: string; displayName: string; type: 'human' | 'agent'; agentProfileId: string | null}>;
  factHash: string;
}>;
export type CurrentExecutionResponsibility = ResolvedWorkItemResponsibility & Readonly<{
  title: string;
  workItemVersion: number;
  planVersionId: string;
  workItemStatus: string;
  protocolId: string;
  protocolVersion: number;
  journeyVersion: number;
  stageKey: string;
  stageName: string;
  executionMode: 'manual' | 'autonomous' | 'human_approval';
}>;
const hashFact = (fact: Parameters<typeof canonicalJson>[0]): string =>
  createHash('sha256').update(canonicalJson(fact)).digest('hex');

export const resolveWorkItemResponsibility = async (
  tx: Queryable,
  input: Readonly<{
    workspaceId: string;
    projectId: string;
    responsibility: ProjectPlanTaskResponsibility;
    requireContributorForHuman: boolean;
    requireUniqueProjectRole: boolean;
  }>
): Promise<ResolvedWorkItemResponsibility | null> => {
  const {workspaceId, projectId, responsibility} = input;
  if (responsibility.kind === 'agent_profile') {
    const rows = await tx.select({
      actorId: schema.actors.id, displayName: schema.actors.displayName,
      membershipId: schema.projectMemberships.id, membershipRoles: schema.projectMemberships.roles,
      membershipVersion: schema.projectMemberships.version, profileId: schema.agentProfiles.id,
      profileVersion: schema.agentProfiles.version, registrationId: schema.runtimeRegistrations.id,
      registrationVersion: schema.runtimeRegistrations.version
    }).from(schema.agentProfiles)
      .innerJoin(schema.actors, eq(schema.actors.id, schema.agentProfiles.actorId))
      .innerJoin(schema.projectMemberships, and(eq(schema.projectMemberships.actorId, schema.actors.id),
        eq(schema.projectMemberships.projectId, projectId), eq(schema.projectMemberships.active, true)))
      .innerJoin(schema.runtimeRegistrations, and(eq(schema.runtimeRegistrations.agentProfileId, schema.agentProfiles.id),
        eq(schema.runtimeRegistrations.actorId, schema.actors.id), eq(schema.runtimeRegistrations.projectId, projectId),
        eq(schema.runtimeRegistrations.enabled, true)))
      .where(and(eq(schema.agentProfiles.id, responsibility.agentProfileId),
        eq(schema.agentProfiles.workspaceId, workspaceId), eq(schema.agentProfiles.enabled, true),
        eq(schema.actors.type, 'agent'), eq(schema.actors.authMode, 'agent'), isNull(schema.actors.disabledAt),
        projectMembershipHasRoleSql(schema.projectMemberships.roles, 'agent')))
      .orderBy(asc(schema.runtimeRegistrations.id)).limit(2).for('share');
    if (rows.length !== 1 || rows[0]!.membershipRoles.length !== 1 || rows[0]!.membershipRoles[0] !== 'agent') return null;
    const row = rows[0]!;
    return {actor: {id: row.actorId, displayName: row.displayName, type: 'agent', agentProfileId: row.profileId},
      factHash: hashFact({kind: responsibility.kind, membershipId: row.membershipId,
        membershipRoles: row.membershipRoles, membershipVersion: row.membershipVersion,
        profileId: row.profileId, profileVersion: row.profileVersion,
        registrationId: row.registrationId, registrationVersion: row.registrationVersion})};
  }
  const rolePredicate = responsibility.kind === 'project_role'
    ? projectMembershipHasRoleSql(schema.projectMemberships.roles, responsibility.role)
    : input.requireContributorForHuman
      ? projectMembershipHasRoleSql(schema.projectMemberships.roles, 'contributor')
      : undefined;
  const rows = await tx.select({actorId: schema.actors.id, displayName: schema.actors.displayName,
    membershipId: schema.projectMemberships.id, membershipRoles: schema.projectMemberships.roles,
    membershipVersion: schema.projectMemberships.version})
    .from(schema.actors).innerJoin(schema.projectMemberships, and(
      eq(schema.projectMemberships.actorId, schema.actors.id), eq(schema.projectMemberships.projectId, projectId),
      eq(schema.projectMemberships.active, true)))
    .where(and(responsibility.kind === 'human' ? eq(schema.actors.id, responsibility.actorId) : undefined,
      eq(schema.actors.workspaceId, workspaceId), eq(schema.actors.type, 'human'),
      eq(schema.actors.authMode, 'user'), isNull(schema.actors.disabledAt), rolePredicate))
    .orderBy(asc(schema.actors.id)).limit(input.requireUniqueProjectRole ? 2 : 1).for('share');
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  return {actor: {id: row.actorId, displayName: row.displayName, type: 'human', agentProfileId: null},
    factHash: hashFact({kind: responsibility.kind, membershipId: row.membershipId,
      membershipRoles: row.membershipRoles, membershipVersion: row.membershipVersion})};
};

export const resolveProtocolResponsibility = async (
  tx: Queryable,
  input: Readonly<{workspaceId: string; projectId: string; responsibility: DeliveryProtocolResponsibility}>
): Promise<ResolvedWorkItemResponsibility | null> => {
  const {workspaceId, projectId, responsibility} = input;
  const roleActors = responsibility.kind === 'project_role'
    ? await tx.select({actorId: schema.projectMemberships.actorId}).from(schema.projectMemberships)
        .innerJoin(schema.actors, eq(schema.actors.id, schema.projectMemberships.actorId))
        .where(and(eq(schema.projectMemberships.projectId, projectId),
          projectMembershipHasRoleSql(schema.projectMemberships.roles, responsibility.role),
          eq(schema.projectMemberships.active, true), eq(schema.actors.workspaceId, workspaceId),
          eq(schema.actors.type, 'human'), isNull(schema.actors.disabledAt)))
        .orderBy(asc(schema.actors.id)).limit(2).for('share')
    : [];
  if (responsibility.kind === 'project_role' && roleActors.length !== 1) return null;
  const actorId = responsibility.kind === 'project_role' ? roleActors[0]!.actorId : responsibility.actorId;
  const [binding] = await tx.select({id: schema.actors.id, displayName: schema.actors.displayName,
    type: schema.actors.type, membershipId: schema.projectMemberships.id,
    membershipRoles: schema.projectMemberships.roles, membershipVersion: schema.projectMemberships.version})
    .from(schema.actors).innerJoin(schema.projectMemberships, and(
      eq(schema.projectMemberships.actorId, schema.actors.id), eq(schema.projectMemberships.projectId, projectId)))
    .where(and(eq(schema.actors.id, actorId), eq(schema.actors.workspaceId, workspaceId),
      eq(schema.projectMemberships.active, true), isNull(schema.actors.disabledAt))).limit(1).for('share');
  if (binding === undefined || (binding.type !== 'human' && binding.type !== 'agent')) return null;
  if (responsibility.kind === 'actor' && responsibility.actorType !== binding.type) return null;
  let agentProfileId: string | null = null;
  let profileFact: {profileId: string; profileVersion: number; registrationId: string; registrationVersion: number} | null = null;
  if (responsibility.kind === 'actor' && responsibility.actorType === 'agent') {
    const profiles = await tx.select({id: schema.agentProfiles.id, version: schema.agentProfiles.version,
      registrationId: schema.runtimeRegistrations.id, registrationVersion: schema.runtimeRegistrations.version})
      .from(schema.agentProfiles).innerJoin(schema.runtimeRegistrations, and(
        eq(schema.runtimeRegistrations.agentProfileId, schema.agentProfiles.id),
        eq(schema.runtimeRegistrations.actorId, schema.agentProfiles.actorId)))
      .where(and(eq(schema.agentProfiles.id, responsibility.agentProfileId),
        eq(schema.agentProfiles.actorId, binding.id), eq(schema.agentProfiles.workspaceId, workspaceId),
        eq(schema.agentProfiles.enabled, true), eq(schema.runtimeRegistrations.projectId, projectId),
        eq(schema.runtimeRegistrations.enabled, true))).orderBy(asc(schema.runtimeRegistrations.id)).limit(2).for('share');
    if (profiles.length !== 1) return null;
    const profile = profiles[0]!;
    agentProfileId = profile.id;
    profileFact = {profileId: profile.id, profileVersion: profile.version,
      registrationId: profile.registrationId, registrationVersion: profile.registrationVersion};
  }
  return {actor: {id: binding.id, displayName: binding.displayName, type: binding.type, agentProfileId},
    factHash: hashFact({kind: 'protocol', membershipId: binding.membershipId,
      membershipRoles: binding.membershipRoles, membershipVersion: binding.membershipVersion, profileFact})};
};

export const resolveCurrentExecutionResponsibility = async (
  tx: Queryable,
  input: Readonly<{workspaceId: string; projectId: string; workItemId: string}>
): Promise<CurrentExecutionResponsibility | null> => {
  const [record] = await tx.select({title: schema.workItems.title, workItemVersion: schema.workItems.version,
    planVersionId: schema.workItems.sourcePlanVersionId, workItemStatus: schema.workItems.status,
    workItemBlocked: schema.workItems.blocked, responsibility: schema.workItems.responsibility,
    protocolId: schema.deliveryJourneys.protocolId, protocolVersion: schema.deliveryJourneys.protocolVersion,
    journeyVersion: schema.deliveryJourneys.version, stageKey: schema.deliveryJourneys.stageKey,
    definition: schema.runbooks.definition, protocolState: schema.runbooks.protocolState,
    active: schema.runbooks.active})
    .from(schema.workItems).innerJoin(schema.projects, eq(schema.projects.id, schema.workItems.projectId))
    .innerJoin(schema.deliveryJourneys, eq(schema.deliveryJourneys.workItemId, schema.workItems.id))
    .innerJoin(schema.runbooks, and(eq(schema.runbooks.id, schema.deliveryJourneys.protocolId),
      eq(schema.runbooks.version, schema.deliveryJourneys.protocolVersion)))
    .where(and(eq(schema.workItems.id, input.workItemId), eq(schema.workItems.projectId, input.projectId),
      eq(schema.projects.workspaceId, input.workspaceId), isNull(schema.workItems.deletedAt))).limit(1).for('share');
  if (record === undefined || record.planVersionId === null || record.workItemBlocked ||
    record.protocolState !== 'published' || !record.active) return null;
  const definition = validateDeliveryProtocolDefinition(record.definition);
  if (!definition.ok) return null;
  const stage = definition.value.stages.find(({key, enabled}) => enabled && key === record.stageKey) ?? null;
  if (stage === null || stage.taskStatus !== record.workItemStatus) return null;
  const resolved = stage.taskStatus === 'in_dev'
    ? record.responsibility === null ? null : await resolveWorkItemResponsibility(tx, {
        workspaceId: input.workspaceId, projectId: input.projectId, responsibility: record.responsibility,
        requireContributorForHuman: record.responsibility.kind === 'human', requireUniqueProjectRole: true})
    : await resolveProtocolResponsibility(tx, {workspaceId: input.workspaceId, projectId: input.projectId,
        responsibility: stage.responsibility});
  return resolved === null ? null : {...resolved, title: record.title, workItemVersion: record.workItemVersion,
    planVersionId: record.planVersionId, workItemStatus: record.workItemStatus,
    protocolId: record.protocolId, protocolVersion: record.protocolVersion,
    journeyVersion: record.journeyVersion, stageKey: stage.key, stageName: stage.name,
    executionMode: stage.executionMode};
};
