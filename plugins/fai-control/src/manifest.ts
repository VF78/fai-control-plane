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
    "access.members.read",
    "plugin.state.read",
    "plugin.state.write",
    "ui.detailTab.register",
    "ui.action.register"
  ],
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
