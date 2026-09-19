import {lstat, readFile, realpath} from "node:fs/promises";
import {join, resolve} from "node:path";
import {projectQaInstructions, type QaAgent} from "./project-qa.js";

export async function verifyProjectQaInstructions(agent: QaAgent, projectId: string, read?: (path: string) => Promise<string>): Promise<void> {
  const root = agent.adapterConfig.instructionsRootPath;
  const file = agent.adapterConfig.instructionsFilePath;
  if (agent.adapterConfig.instructionsBundleMode !== "managed" || agent.adapterConfig.instructionsEntryFile !== "AGENTS.md" ||
      typeof root !== "string" || typeof file !== "string" || resolve(file) !== join(resolve(root), "AGENTS.md") ||
      !resolve(root).endsWith(join("companies", agent.companyId, "agents", agent.id, "instructions"))) throw new Error("project_qa_instructions_unverified");
  if (!read) {
    const [rootStat, fileStat, actualRoot, actualFile] = await Promise.all([lstat(root), lstat(file), realpath(root), realpath(file)]);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !fileStat.isFile() || fileStat.isSymbolicLink() || actualFile !== join(actualRoot, "AGENTS.md")) throw new Error("project_qa_instructions_unverified");
  }
  const content = read ? await read(file) : await readFile(file, "utf8");
  if (content !== projectQaInstructions(projectId)) throw new Error("project_qa_instructions_unverified");
}
