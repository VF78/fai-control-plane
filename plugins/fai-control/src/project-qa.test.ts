import {expect, test} from "vitest";
import {assertProjectQa, isProjectQaCandidate, parseProjectQaState, projectCodexHome, projectQaInstructions, projectQaInstructionsDisposition, selectProjectQaCandidate} from "./project-qa.js";
import {verifyProjectQaInstructions} from "./project-qa-runtime.js";

const agent = {id: "qa", companyId: "company", role: "qa", adapterType: "codex_local", status: "paused",
  adapterConfig: {dangerouslyBypassApprovalsAndSandbox: false, env: {CODEX_HOME: {type: "plain", value: "/var/lib/fai-control/hermes/company/project/codex-home"}}, instructionsBundleMode: "managed", instructionsRootPath: "/root/companies/company/agents/qa/instructions", instructionsEntryFile: "AGENTS.md", instructionsFilePath: "/root/companies/company/agents/qa/instructions/AGENTS.md"},
  runtimeConfig: {heartbeat: {enabled: false, maxConcurrentRuns: 1}},
  metadata: {faiProjectId: "project", faiRole: "qa", faiQaPolicyVersion: 1}};

test("accepts only a distinct project-scoped QA identity with bounded native runtime policy", () => {
  expect(isProjectQaCandidate(agent, "project")).toBe(true);
  expect(() => assertProjectQa(agent, "company", "project", "hermes")).not.toThrow();
  expect(() => assertProjectQa(agent, "company", "project", "qa")).toThrow("identity_invalid");
  expect(() => assertProjectQa({...agent, metadata: {...agent.metadata, faiProjectId: "other"}}, "company", "project", "hermes")).toThrow();
  expect(() => assertProjectQa({...agent, runtimeConfig: {heartbeat: {enabled: false, maxConcurrentRuns: 20}}}, "company", "project", "hermes")).toThrow("runtime_policy_invalid");
  expect(() => assertProjectQa({...agent, adapterConfig: {...agent.adapterConfig, dangerouslyBypassApprovalsAndSandbox: true}}, "company", "project", "hermes")).toThrow("adapter_policy_invalid");
  expect(() => assertProjectQa({...agent, adapterConfig: {...agent.adapterConfig, env: {CODEX_HOME: {type: "plain", value: "/var/lib/fai-control/hermes/company/other/codex-home"}}}}, "company", "project", "hermes")).toThrow("login_scope_invalid");
  expect(() => assertProjectQa({...agent, adapterConfig: {...agent.adapterConfig, extraArgs: ["--sandbox", "danger-full-access"]}}, "company", "project", "hermes")).toThrow("adapter_policy_invalid");
  expect(selectProjectQaCandidate([agent], "project")?.id).toBe("qa");
  expect(selectProjectQaCandidate([{...agent, metadata: null}], "project")).toBeNull();
  expect(() => selectProjectQaCandidate([agent, {...agent, id: "qa-2"}], "project")).toThrow("duplicate_identity");
});

test("derives one isolated Codex login home per project", () => {
  expect(projectCodexHome("company", "project-a")).toBe("/var/lib/fai-control/hermes/company/project-a/codex-home");
  expect(projectCodexHome("company", "project-b")).not.toBe(projectCodexHome("company", "project-a"));
  expect(() => projectCodexHome("company", "../other")).toThrow("identity_invalid");
});

test("state and actual loaded instructions remain project scoped", async () => {
  expect(parseProjectQaState({agentId: "qa", revision: 1})).toEqual({agentId: "qa", revision: 1});
  expect(parseProjectQaState({agentId: "qa", revision: 0})).toBeNull();
  const instructions = projectQaInstructions("project-123");
  expect(instructions).toContain("project ID is exactly project-123");
  expect(instructions).toContain("only deterministic lint or formatting defects");
  expect(instructions).toContain("human approval remain explicit native task actions");
  expect(instructions).toContain("one native issue comment or decision");
  expect(projectQaInstructionsDisposition(null, instructions)).toBe("write");
  expect(projectQaInstructionsDisposition(instructions, instructions)).toBe("present");
  expect(() => projectQaInstructionsDisposition("custom", instructions)).toThrow("instructions_conflict");
  await expect(verifyProjectQaInstructions(agent, "project-123", async () => instructions)).resolves.toBeUndefined();
  await expect(verifyProjectQaInstructions(agent, "project-123", async () => "generic")).rejects.toThrow("instructions_unverified");
  await expect(verifyProjectQaInstructions({...agent, adapterConfig: {...agent.adapterConfig, instructionsFilePath: "/tmp/AGENTS.md"}}, "project-123", async () => instructions)).rejects.toThrow("instructions_unverified");
});
