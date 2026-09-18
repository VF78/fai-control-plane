import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "vf78.fai-control",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "f(AI) Control",
  description: "Connects a Paperclip project to its repository, document context, and team labels.",
  author: "VF78",
  categories: ["connector", "ui"],
  capabilities: [
    "projects.read",
    "agents.read",
    "access.members.read",
    "plugin.state.read",
    "plugin.state.write",
    "ui.detailTab.register",
    "ui.action.register"
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      hermesHostBindings: {
        type: "object",
        description: "Operator-provisioned project host references. No credential values. Root must be /var/lib/fai-control/hermes/<companyId>/<projectId>.",
        additionalProperties: {
          type: "object",
          required: ["companyId", "projectId", "agentId", "root", "apiBaseUrl", "runtimeWorkspace"],
          additionalProperties: false,
          properties: {
            companyId: {type: "string"}, projectId: {type: "string"}, agentId: {type: "string"},
            root: {type: "string"}, apiBaseUrl: {type: "string"}, runtimeWorkspace: {type: "string"}
          }
        }
      }
    },
    additionalProperties: false
  },
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  ui: {
    slots: [
      {
        type: "detailTab",
        id: "repository-binding",
        displayName: "Repository",
        exportName: "ProjectRepositoryTab",
        entityTypes: ["project"]
      },
      {
        type: "detailTab",
        id: "team-roles",
        displayName: "Team & roles",
        exportName: "ProjectTeamRolesTab",
        entityTypes: ["project"]
      },
      {
        type: "detailTab",
        id: "setup",
        displayName: "Setup",
        exportName: "ProjectSetupWizardTab",
        entityTypes: ["project"]
      },
      {
        type: "detailTab",
        id: "documents",
        displayName: "Documents",
        exportName: "ProjectDocumentsTab",
        entityTypes: ["project"]
      }
    ]
  }
};

export default manifest;
