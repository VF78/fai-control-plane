import { describe, expect, it } from "vitest";
import { createRepositoryBinding, normalizeGitHubBranch, normalizeGitHubRepositoryUrl } from "./repository-binding.js";

describe("GitHub repository binding", () => {
  it("normalizes supported GitHub HTTPS and SSH URLs", () => {
    expect(normalizeGitHubRepositoryUrl("git@github.com:VF78/fai-control-plane.git")).toMatchObject({
      repositoryUrl: "https://github.com/VF78/fai-control-plane"
    });
  });

  it("rejects URLs outside the GitHub repository edge", () => {
    expect(() => normalizeGitHubRepositoryUrl("https://github.com/VF78/fai-control-plane/issues")).toThrow();
    expect(() => normalizeGitHubRepositoryUrl("https://example.com/VF78/fai-control-plane")).toThrow();
    expect(() => normalizeGitHubRepositoryUrl("https://github.com:8443/VF78/fai-control-plane")).toThrow();
  });

  it("stores a branch as an exact Git ref and leaves access unchecked", () => {
    expect(createRepositoryBinding({repositoryUrl: "https://github.com/VF78/fai-control-plane", branch: "refs/heads/main"}))
      .toMatchObject({ref: "refs/heads/main", access: {status: "not_checked"}});
    expect(() => normalizeGitHubBranch("feature/../escape")).toThrow();
    expect(() => normalizeGitHubBranch("release@{1}")).toThrow();
    expect(() => normalizeGitHubBranch("release.lock")).toThrow();
  });
});
