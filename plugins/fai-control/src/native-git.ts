import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { RepositoryAccess, RepositoryBinding } from "./repository-binding.js";

const execFileAsync = promisify(execFile);

export function nativeGitEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {...environment, HOME: environment.HOME || homedir(), GIT_TERMINAL_PROMPT: "0"};
}

export async function verifyWithNativeGit(binding: RepositoryBinding): Promise<RepositoryAccess> {
  const command = process.env.FAI_GIT_BIN ||
    (process.platform === "darwin" && existsSync("/Library/Developer/CommandLineTools/usr/bin/git")
      ? "/Library/Developer/CommandLineTools/usr/bin/git" : "git");
  try {
    await execFileAsync(command, ["ls-remote", "--exit-code", binding.repositoryUrl, binding.ref], {
      timeout: 20_000,
      maxBuffer: 4 * 1024,
      env: nativeGitEnvironment()
    });
    return {status: "verified", checkedAt: new Date().toISOString()};
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as {code?: unknown}).code : undefined;
    return {
      status: "unverified",
      checkedAt: new Date().toISOString(),
      reason: code === "ENOENT" ? "git_unavailable" : code === "ETIMEDOUT" ? "verification_timeout" : "access_denied_or_ref_missing"
    };
  }
}
