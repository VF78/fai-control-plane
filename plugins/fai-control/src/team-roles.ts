import type { PluginAccessMember } from "@paperclipai/plugin-sdk";

export const projectTeamRoles = ["owner", "pm", "executor", "client_representative"] as const;
export type ProjectTeamRole = typeof projectTeamRoles[number];

export type ProjectTeamRoleMapping = Readonly<{
  contract: "fai.project-team-roles.v1";
  assignments: Readonly<Partial<Record<ProjectTeamRole, string>>>;
}>;

export type ProjectTeamRoleView = Readonly<{
  members: readonly Readonly<{
    id: string;
    principalId: string;
    membershipRole: string | null;
    status: string;
  }>[];
  mapping: ProjectTeamRoleMapping;
}>;

export function parseProjectTeamRoleMapping(value: unknown): ProjectTeamRoleMapping {
  if (!value || typeof value !== "object") return {contract: "fai.project-team-roles.v1", assignments: {}};
  const candidate = value as {contract?: unknown; assignments?: unknown};
  if (candidate.contract !== "fai.project-team-roles.v1" || !candidate.assignments || typeof candidate.assignments !== "object") {
    return {contract: "fai.project-team-roles.v1", assignments: {}};
  }
  const assignments: Partial<Record<ProjectTeamRole, string>> = {};
  for (const role of projectTeamRoles) {
    const memberId = (candidate.assignments as Record<string, unknown>)[role];
    if (typeof memberId === "string" && memberId.length > 0 && memberId.length <= 200) assignments[role] = memberId;
  }
  return {contract: "fai.project-team-roles.v1", assignments};
}

export function createProjectTeamRoleMapping(input: unknown, members: readonly PluginAccessMember[]): ProjectTeamRoleMapping {
  if (!input || typeof input !== "object") throw new Error("team_roles_required");
  const assignments = (input as {assignments?: unknown}).assignments;
  if (!assignments || typeof assignments !== "object" || Array.isArray(assignments)) throw new Error("team_role_assignments_invalid");
  const activeHumanMemberIds = new Set(members.filter((member) => member.principalType === "user" && member.status === "active")
    .map((member) => member.id));
  const output: Partial<Record<ProjectTeamRole, string>> = {};
  for (const role of projectTeamRoles) {
    const memberId = (assignments as Record<string, unknown>)[role];
    if (memberId === null || memberId === undefined || memberId === "") continue;
    if (typeof memberId !== "string" || !activeHumanMemberIds.has(memberId)) throw new Error("team_role_member_not_active_in_company");
    output[role] = memberId;
  }
  return {contract: "fai.project-team-roles.v1", assignments: output};
}

export function projectTeamRoleView(members: readonly PluginAccessMember[], mapping: ProjectTeamRoleMapping): ProjectTeamRoleView {
  return {
    members: members.filter((member) => member.principalType === "user").map((member) => ({
      id: member.id,
      principalId: member.principalId,
      membershipRole: member.membershipRole,
      status: member.status
    })),
    mapping
  };
}
