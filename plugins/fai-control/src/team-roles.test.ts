import { describe, expect, it } from "vitest";
import type { PluginAccessMember } from "@paperclipai/plugin-sdk";
import { createProjectTeamRoleMapping } from "./team-roles.js";

const activeMember = (id: string, companyId = "company-a"): PluginAccessMember => ({
  id, companyId, principalType: "user", principalId: `principal-${id}`, status: "active", membershipRole: "operator",
  grants: [], createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z"
});

describe("project team role mapping", () => {
  it("rejects a member that is not an active native member in this company", () => {
    expect(() => createProjectTeamRoleMapping({assignments: {owner: "member-from-company-b"}}, [activeMember("member-a")]))
      .toThrow("team_role_member_not_active_in_company");
  });

  it("stores only semantic role associations for active human members", () => {
    expect(createProjectTeamRoleMapping({assignments: {owner: "member-a", client_representative: "member-a"}}, [activeMember("member-a")]))
      .toEqual({contract: "fai.project-team-roles.v1", assignments: {owner: "member-a", client_representative: "member-a"}});
  });
});
