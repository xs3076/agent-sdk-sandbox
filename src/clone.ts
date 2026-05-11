import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * 仓库克隆与拉取(独立于评审流)。
 *
 * 设计原则:
 *  - workDir 只能落在 /workspace 之下(容器挂载点),路径任何尝试越界一律拒绝。
 *  - 只支持 https:// repoUrl(不开 ssh / git / file 协议,杜绝本地路径或 ssh
 *    凭证被滥用)。
 *  - 鉴权 token 通过 URL userinfo 注入,clone/fetch 完成后立刻把 origin 改回
 *    不带凭证的 URL,避免 .git/config 残留密钥。
 *  - 仓库已存在但 origin 不一致:报错。决不静默覆盖用户数据。
 *  - 始终 `checkout --detach FETCH_HEAD`,避免在本地建分支引起后续 review 时
 *    git 提示分支落后/超前等噪声。
 */

const WORKSPACE_ROOT = "/workspace";
const DEFAULT_DEPTH = 50;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface CloneRequest {
  /** https:// 仓库地址,例如 https://github.com/expressjs/express.git */
  repoUrl: string;
  /** 容器内目标路径,必须是 /workspace 子目录,例如 /workspace/express */
  workDir: string;
  /** 分支 / tag / commit SHA,缺省走远端 HEAD */
  ref?: string;
  /** 浅克隆深度,默认 50;传 0 表示完整克隆 */
  depth?: number;
  /** 私有仓库 token(GitHub PAT / GitLab token 等);完成后会被擦除 */
  authToken?: string;
  /** git 子进程超时(ms),默认 600000 */
  timeoutMs?: number;
}

export interface CloneResult {
  workDir: string;
  /** 当前 HEAD commit SHA */
  head: string;
  /** 当前分支名;detached 时是 "HEAD" */
  branch: string;
}

export class CloneError extends Error {
  public stderr?: string;
  constructor(message: string, stderr?: string) {
    super(message);
    this.name = "CloneError";
    this.stderr = stderr;
  }
}

function validateWorkDir(input: string | undefined): string {
  if (!input || !path.isAbsolute(input)) {
    throw new CloneError(`workDir must be an absolute path: ${input}`);
  }
  const normalized = path.resolve(input);
  const rel = path.relative(WORKSPACE_ROOT, normalized);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new CloneError(`workDir must be a subdirectory of ${WORKSPACE_ROOT}: ${input}`);
  }
  return normalized;
}

function parseRepoUrl(input: string | undefined): URL {
  if (!input) throw new CloneError("repoUrl is required");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CloneError(`invalid repoUrl: ${input}`);
  }
  if (url.protocol !== "https:") {
    throw new CloneError(`only https:// repoUrl is supported, got ${url.protocol}`);
  }
  // 输入若带了 userinfo 一律抹掉,鉴权一切走 authToken。
  url.username = "";
  url.password = "";
  return url;
}

function validateRef(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  if (!ref || ref.startsWith("-")) {
    throw new CloneError(`invalid ref: ${ref}`);
  }
  return ref;
}

function withAuth(url: URL, token: string): string {
  const u = new URL(url.toString());
  u.username = "x-access-token";
  u.password = token;
  return u.toString();
}

function stripUserinfo(input: string): string {
  try {
    const u = new URL(input);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return input;
  }
}

function scrubToken(text: string, token?: string): string {
  return token ? text.split(token).join("***") : text;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function depthArgs(req: CloneRequest): string[] {
  const d = req.depth ?? DEFAULT_DEPTH;
  return d > 0 ? ["--depth", String(d)] : [];
}

async function execGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        // 关掉一切交互式凭证提示——容器里没人输入。
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/echo",
      },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new CloneError(`git ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new CloneError(`git ${args[0]} spawn failed: ${err.message}`));
    });
    proc.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new CloneError(`git ${args[0]} exited code=${code} signal=${signal ?? "-"}`, stderr));
    });
  });
}

export async function runClone(req: CloneRequest, reqId: string): Promise<CloneResult> {
  const tag = `[req ${reqId}]`;
  const workDir = validateWorkDir(req.workDir);
  const url = parseRepoUrl(req.repoUrl);
  const ref = validateRef(req.ref);
  const safeUrl = url.toString();
  const authUrl = req.authToken ? withAuth(url, req.authToken) : safeUrl;
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  console.log(
    `${tag} clone start url=${safeUrl} workDir=${workDir} ref=${ref ?? "(default)"} depth=${req.depth ?? DEFAULT_DEPTH}`,
  );

  try {
    const dotGit = path.join(workDir, ".git");
    if (await pathExists(dotGit)) {
      // 已有仓库:核对 origin → 临时塞 token → fetch + 切到 FETCH_HEAD → 擦回 origin。
      const { stdout } = await execGit(["remote", "get-url", "origin"], workDir, timeoutMs);
      const stored = stripUserinfo(stdout.trim());
      if (stored !== safeUrl) {
        throw new CloneError(
          `${workDir} has different origin: stored=${stored} requested=${safeUrl}`,
        );
      }
      if (req.authToken) {
        await execGit(["remote", "set-url", "origin", authUrl], workDir, timeoutMs);
      }
      try {
        const fetchArgs = ["fetch", "-q", "--prune", ...depthArgs(req), "origin", ref ?? "HEAD"];
        await execGit(fetchArgs, workDir, timeoutMs);
        await execGit(["checkout", "-q", "--detach", "FETCH_HEAD"], workDir, timeoutMs);
      } finally {
        if (req.authToken) {
          await execGit(["remote", "set-url", "origin", safeUrl], workDir, timeoutMs);
        }
      }
    } else if (await pathExists(workDir)) {
      throw new CloneError(`${workDir} exists but is not a git repo`);
    } else {
      // 全新克隆:init + fetch + checkout,SHA / 分支 / tag 一套流程通吃。
      await fs.mkdir(workDir, { recursive: true });
      await execGit(["init", "-q"], workDir, timeoutMs);
      await execGit(["remote", "add", "origin", authUrl], workDir, timeoutMs);
      try {
        const fetchArgs = ["fetch", "-q", ...depthArgs(req), "origin", ref ?? "HEAD"];
        await execGit(fetchArgs, workDir, timeoutMs);
        await execGit(["checkout", "-q", "--detach", "FETCH_HEAD"], workDir, timeoutMs);
      } finally {
        if (req.authToken) {
          await execGit(["remote", "set-url", "origin", safeUrl], workDir, timeoutMs);
        }
      }
    }

    const { stdout: head } = await execGit(["rev-parse", "HEAD"], workDir, timeoutMs);
    const { stdout: branch } = await execGit(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      workDir,
      timeoutMs,
    );
    const result: CloneResult = { workDir, head: head.trim(), branch: branch.trim() };
    console.log(`${tag} clone done head=${result.head} branch=${result.branch}`);
    return result;
  } catch (err) {
    if (err instanceof CloneError && err.stderr) {
      err.stderr = scrubToken(err.stderr, req.authToken);
    }
    if (err instanceof CloneError) {
      err.message = scrubToken(err.message, req.authToken);
    }
    throw err;
  }
}
