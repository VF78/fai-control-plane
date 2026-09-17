export type RepositoryAccess = Readonly<{
  status: "not_checked" | "verified" | "unverified";
  checkedAt?: string;
  reason?: "git_unavailable" | "access_denied_or_ref_missing" | "verification_timeout";
}>;

export type RepositoryBinding = Readonly<{
  contract: "fai.repository-binding.v1";
  provider: "github";
  repositoryUrl: string;
  owner: string;
  repository: string;
  branch: string;
  ref: string;
  access: RepositoryAccess;
}>;

export type ProjectRepositoryBindingView = Readonly<{
  binding: RepositoryBinding | null;
  nativeWorkspace: Readonly<{
    workspaceId: string | null;
    repositoryUrl: string | null;
    branch: string | null;
    matchesBinding: boolean;
  }>;
}>;

const repositoryPart = /^[A-Za-z0-9_.-]+$/;

export function normalizeGitHubRepositoryUrl(value: string): Pick<RepositoryBinding,
  "provider" | "repositoryUrl" | "owner" | "repository"> {
  const raw = value.trim();
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(raw);
  if (ssh) return normalizeParts(ssh[1]!, ssh[2]!);

  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("github_repository_url_invalid"); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port || url.username ||
    url.password || url.search || url.hash) throw new Error("github_repository_url_invalid");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) throw new Error("github_repository_url_invalid");
  return normalizeParts(parts[0]!, parts[1]!.replace(/\.git$/i, ""));
}

function normalizeParts(owner: string, repository: string): Pick<RepositoryBinding,
  "provider" | "repositoryUrl" | "owner" | "repository"> {
  if (!repositoryPart.test(owner) || !repositoryPart.test(repository)) throw new Error("github_repository_url_invalid");
  return {provider: "github", owner, repository, repositoryUrl: `https://github.com/${owner}/${repository}`};
}

export function normalizeGitHubBranch(value: string): Pick<RepositoryBinding, "branch" | "ref"> {
  const branch = value.trim().replace(/^refs\/heads\//, "");
  if (!branch || branch.length > 255 || branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/") ||
    branch.endsWith(".") || branch.includes("..") || branch.includes("//") || branch.includes("@{") ||
    branch.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")) ||
    /[\s~^:?*\\[\x00-\x1f]/.test(branch)) {
    throw new Error("github_branch_invalid");
  }
  return {branch, ref: `refs/heads/${branch}`};
}

export function createRepositoryBinding(input: Readonly<{repositoryUrl: string; branch: string}>): RepositoryBinding {
  return {
    contract: "fai.repository-binding.v1",
    ...normalizeGitHubRepositoryUrl(input.repositoryUrl),
    ...normalizeGitHubBranch(input.branch),
    access: {status: "not_checked"}
  };
}

export function parseRepositoryBinding(value: unknown): RepositoryBinding | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RepositoryBinding>;
  if (candidate.contract !== "fai.repository-binding.v1" || candidate.provider !== "github" ||
    typeof candidate.repositoryUrl !== "string" || typeof candidate.branch !== "string" ||
    !candidate.access || typeof candidate.access !== "object") return null;
  try {
    const binding = createRepositoryBinding({repositoryUrl: candidate.repositoryUrl, branch: candidate.branch});
    const access = candidate.access as Partial<RepositoryAccess>;
    if (access.status === "verified" || access.status === "unverified") {
      return {...binding, access: {
        status: access.status,
        ...(typeof access.checkedAt === "string" ? {checkedAt: access.checkedAt} : {}),
        ...(access.reason === "git_unavailable" || access.reason === "access_denied_or_ref_missing" ||
          access.reason === "verification_timeout" ? {reason: access.reason} : {})
      }};
    }
    return binding;
  } catch { return null; }
}
