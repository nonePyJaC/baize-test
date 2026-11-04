import { isTauri } from "./api";
import type { GitCommit, GitFetchResult, GitFileStatus, GitPullResult, GitResource, GitStatus } from "./types";

const COMMIT_FIELD_SEPARATOR = "\u001f";
const COMMIT_RECORD_SEPARATOR = "\u001e";

type GitCommandOutput = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export function normalizeGitResource(value: Partial<GitResource> & { id: string }): GitResource {
  const appType = value.app_type === "frontend" || value.app_type === "backend" ? value.app_type : "other";
  return {
    id: value.id,
    application_name: value.application_name?.trim() || "未命名应用",
    local_path: value.local_path?.trim() || "",
    repository_url: value.repository_url?.trim() || "",
    current_branch: value.current_branch?.trim() || "",
    current_commit: value.current_commit?.trim() || "",
    expected_branch: value.expected_branch?.trim() || "",
    app_type: appType,
  };
}

export function emptyGitStatus(resource: GitResource): GitStatus {
  return {
    resource_id: resource.id,
    local_path: resource.local_path,
    is_git_repo: false,
    branch: null,
    commit: null,
    remote: null,
    upstream_branch: null,
    uncommitted_files: [],
    ahead: 0,
    behind: 0,
    recent_commits: [],
    incoming_commits: [],
    can_fast_forward: false,
    checked_at: new Date().toISOString(),
    error: null,
  };
}

export async function readGitStatus(resource: GitResource): Promise<GitStatus> {
  const base = emptyGitStatus(resource);
  if (!resource.local_path.trim()) return { ...base, error: "尚未配置本地仓库路径" };
  if (!isTauri) {
    return {
      ...base,
      error: "浏览器开发模式不执行外部 Git 命令，请在 Tauri 桌面客户端中读取真实仓库状态",
    };
  }

  const inside = await executeGit(resource.local_path, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return {
      ...base,
      error: cleanCommandError(inside, "目录不是 Git 仓库或无法读取 Git"),
    };
  }

  const branchResult = await executeGit(resource.local_path, ["branch", "--show-current"]);
  const commitResult = await executeGit(resource.local_path, ["rev-parse", "HEAD"]);
  const remoteResult = await executeGit(resource.local_path, ["remote", "get-url", "origin"]);
  const upstreamResult = await executeGit(resource.local_path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const statusResult = await executeGit(resource.local_path, ["status", "--porcelain=v1"]);
  const recentResult = await executeGit(resource.local_path, [
    "log",
    "-n",
    "8",
    "--date=iso-strict",
    `--pretty=format:%H${COMMIT_FIELD_SEPARATOR}%h${COMMIT_FIELD_SEPARATOR}%an${COMMIT_FIELD_SEPARATOR}%ad${COMMIT_FIELD_SEPARATOR}%s${COMMIT_RECORD_SEPARATOR}`,
  ]);

  const branch = branchResult.code === 0 && branchResult.stdout.trim() ? branchResult.stdout.trim() : null;
  const commit = commitResult.code === 0 && commitResult.stdout.trim() ? commitResult.stdout.trim() : null;
  const upstreamBranch = upstreamResult.code === 0 && upstreamResult.stdout.trim() ? upstreamResult.stdout.trim() : null;
  const remote = remoteResult.code === 0 && remoteResult.stdout.trim() ? remoteResult.stdout.trim().split(/\r?\n/)[0] : null;
  const uncommittedFiles = statusResult.code === 0 ? parseGitFileStatuses(statusResult.stdout) : [];
  const recentCommits = recentResult.code === 0 ? parseGitCommits(recentResult.stdout) : [];
  let ahead = 0;
  let behind = 0;
  let incomingCommits: GitCommit[] = [];
  let canFastForward = false;

  if (upstreamBranch) {
    const counts = await executeGit(resource.local_path, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    const countParts = counts.stdout.trim().split(/\s+/).map((item) => Number.parseInt(item, 10));
    ahead = Number.isFinite(countParts[0]) ? countParts[0] : 0;
    behind = Number.isFinite(countParts[1]) ? countParts[1] : 0;
    const incomingResult = await executeGit(resource.local_path, [
      "log",
      "-n",
      "20",
      "--date=iso-strict",
      `--pretty=format:%H${COMMIT_FIELD_SEPARATOR}%h${COMMIT_FIELD_SEPARATOR}%an${COMMIT_FIELD_SEPARATOR}%ad${COMMIT_FIELD_SEPARATOR}%s${COMMIT_RECORD_SEPARATOR}`,
      "HEAD..@{upstream}",
    ]);
    if (incomingResult.code === 0) incomingCommits = parseGitCommits(incomingResult.stdout);
    const ancestorResult = await executeGit(resource.local_path, ["merge-base", "--is-ancestor", "HEAD", "@{upstream}"]);
    canFastForward = ahead === 0 && behind > 0 && ancestorResult.code === 0;
  }

  const commandErrors = [commitResult, statusResult]
    .filter((result) => result.code !== 0)
    .map((result) => result.stderr.trim() || result.stdout.trim())
    .filter(Boolean);
  return {
    ...base,
    is_git_repo: true,
    branch,
    commit,
    remote,
    upstream_branch: upstreamBranch,
    uncommitted_files: uncommittedFiles,
    ahead,
    behind,
    recent_commits: recentCommits,
    incoming_commits: incomingCommits,
    can_fast_forward: canFastForward,
    checked_at: new Date().toISOString(),
    error: commandErrors.length ? commandErrors[0] : null,
  };
}

export async function fetchGitResource(resource: GitResource): Promise<GitFetchResult> {
  if (!isTauri) {
    return {
      status: await readGitStatus(resource),
      output: "浏览器开发模式未执行 fetch",
    };
  }
  const result = await executeGit(resource.local_path, ["fetch", "--prune"]);
  if (result.code !== 0) throw new Error(cleanCommandError(result, "Git fetch 失败"));
  return {
    status: await readGitStatus(resource),
    output: result.stdout.trim() || result.stderr.trim() || "fetch 完成，远端没有新的输出",
  };
}

export async function pullGitResourceFastForward(resource: GitResource): Promise<GitPullResult> {
  if (!isTauri) throw new Error("浏览器开发模式不执行 Git pull");
  const before = await readGitStatus(resource);
  assertFastForwardReady(before);
  const ancestor = await executeGit(resource.local_path, ["merge-base", "--is-ancestor", "HEAD", "@{upstream}"]);
  if (ancestor.code !== 0) throw new Error("当前分支不是远端分支的祖先，已阻止 pull；请先人工处理分叉");
  const result = await executeGit(resource.local_path, ["pull", "--ff-only"]);
  if (result.code !== 0) throw new Error(cleanCommandError(result, "Git pull --ff-only 失败"));
  return {
    status: await readGitStatus(resource),
    output: result.stdout.trim() || result.stderr.trim() || "fast-forward pull 完成",
  };
}

export function assertFastForwardReady(status: GitStatus): void {
  if (!status.is_git_repo) throw new Error(status.error || "当前目录不是 Git 仓库");
  if (status.uncommitted_files.length) throw new Error("工作区存在未提交文件，已阻止 pull；请先由用户处理本地修改");
  if (!status.upstream_branch) throw new Error("当前分支没有配置远端跟踪分支");
  if (status.ahead > 0) throw new Error("本地分支包含远端没有的提交，不能执行 fast-forward pull");
  if (status.behind <= 0) throw new Error("当前没有可拉取的远端提交");
  if (!status.can_fast_forward) throw new Error("当前更新不是 fast-forward，已阻止 pull");
}

async function executeGit(cwd: string, args: string[]): Promise<GitCommandOutput> {
  try {
    const { Command } = await import("@tauri-apps/plugin-shell");
    const output = await Command.create("git", args, { cwd }).execute();
    return {
      code: output.code,
      stdout: typeof output.stdout === "string" ? output.stdout : "",
      stderr: typeof output.stderr === "string" ? output.stderr : "",
    };
  } catch (reason) {
    return { code: -1, stdout: "", stderr: String(reason) };
  }
}

function parseGitFileStatuses(output: string): GitFileStatus[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2).trim() || "??", path: line.slice(3).trim() || line.trim() }));
}

function parseGitCommits(output: string): GitCommit[] {
  return output
    .split(COMMIT_RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = "", shortHash = "", author = "", date = "", ...subjectParts] = record.split(COMMIT_FIELD_SEPARATOR);
      return {
        hash,
        short_hash: shortHash,
        author,
        date,
        subject: subjectParts.join(COMMIT_FIELD_SEPARATOR),
      };
    })
    .filter((commit) => commit.hash);
}

function cleanCommandError(result: GitCommandOutput, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}
