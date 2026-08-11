import type {ProjectMembershipRole} from '@fai-control-plane/domain';
import {sql, type SQL} from 'drizzle-orm';
import type {PgColumn} from 'drizzle-orm/pg-core';

const projectMembershipRoleArraySql = (
  roles: readonly ProjectMembershipRole[]
): SQL => sql`array[${sql.join(roles.map((role) => sql`${role}`), sql`, `)}]::project_membership_role[]`;

export const projectMembershipHasRoleSql = (
  column: PgColumn,
  role: ProjectMembershipRole
): SQL => sql`${column} @> ${projectMembershipRoleArraySql([role])}`;

export const projectMembershipHasAnyRoleSql = (
  column: PgColumn,
  roles: readonly ProjectMembershipRole[]
): SQL => sql`${column} && ${projectMembershipRoleArraySql(roles)}`;
