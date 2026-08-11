import type {ProjectMembershipRole} from '@fai-control-plane/domain';
import {sql, type SQL} from 'drizzle-orm';
import type {PgColumn} from 'drizzle-orm/pg-core';

export const projectMembershipHasRoleSql = (
  column: PgColumn,
  role: ProjectMembershipRole
): SQL => sql`${column} @> array[${role}]::project_membership_role[]`;

export const projectMembershipHasAnyRoleSql = (
  column: PgColumn,
  roles: readonly ProjectMembershipRole[]
): SQL => sql`${column} && ${roles}::project_membership_role[]`;
