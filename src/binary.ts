import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";

const execFileP = promisify(execFile);

/**
 * 当前 Node 进程对应的 SDK 原生子包名(与 SDK 内部 F5() 解析逻辑一致)。
 *  - linux:           @anthropic-ai/claude-agent-sdk-linux-${arch}
 *  - darwin / win32:  @anthropic-ai/claude-agent-sdk-${platform}-${arch}
 *
 * 部署镜像为 debian-slim(glibc),不存在 musl 子包;本地 darwin 同理无 libc 分支。
 * 故不再做 glibc/musl 判定,linux 一律取无后缀的 glibc 子包。
 */
export function nativePackageName(): string {
  const { platform, arch } = process;
  if (platform === "linux") {
    return `@anthropic-ai/claude-agent-sdk-linux-${arch}`;
  }
  return `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
}

/**
 * 解析当前平台对应的 claude 可执行文件绝对路径。
 *
 * 不走 SDK 的 require.resolve 兜底链:那条链按顺序探测多个平台子包,多架构镜像
 * (amd64/arm64)里一旦 optionalDependencies 装错 arch,它会解析出另一架构的二进制,
 * spawn 后 kernel 回 ENOENT 被 SDK 误报成 "native binary not found",和"包没装"
 * 完全混在一起。这里强制只用当前平台的子包,任何不匹配都立即抛错。
 */
export function resolveBinaryPath(): string {
  const pkg = nativePackageName();
  const ext = process.platform === "win32" ? ".exe" : "";
  // require.resolve('pkg/package.json') 在 CJS 下直接可用,不依赖 import.meta。
  const pkgJsonPath = require.resolve(`${pkg}/package.json`);
  return path.join(path.dirname(pkgJsonPath), `claude${ext}`);
}

export interface BinaryCheck {
  path: string;
  version: string;
  package: string;
}

/**
 * 启动期一次性烟测:解析路径 → 校验文件存在 + 可执行 → 真实 spawn `--version`。
 * 三步必须全部通过,否则抛出带上下文的错误(列出 @anthropic-ai 目录、文件 stat、
 * 平台信息),便于 Docker 构建/启动失败时直接定位。
 */
export async function verifyBinary(timeoutMs = 8000): Promise<BinaryCheck> {
  const pkg = nativePackageName();
  let binPath: string;
  try {
    binPath = resolveBinaryPath();
  } catch (err) {
    throw new Error(
      `native pkg ${pkg} not installed (require.resolve failed). ${diagnostics()}`,
      { cause: err as Error },
    );
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(binPath);
  } catch (err) {
    throw new Error(`${binPath} missing. ${diagnostics()}`, { cause: err as Error });
  }
  if (!stat.isFile()) {
    throw new Error(`${binPath} exists but is not a regular file (mode=${stat.mode.toString(8)})`);
  }
  // 0o111 = any execute bit
  if ((stat.mode & 0o111) === 0) {
    throw new Error(`${binPath} not executable (mode=${stat.mode.toString(8)}). ${diagnostics()}`);
  }

  try {
    const { stdout } = await execFileP(binPath, ["--version"], { timeout: timeoutMs });
    return { path: binPath, version: stdout.trim(), package: pkg };
  } catch (err) {
    throw new Error(
      `${binPath} --version failed (likely arch mismatch on this host). ${diagnostics()}`,
      { cause: err as Error },
    );
  }
}

function diagnostics(): string {
  const parts: string[] = [
    `platform=${process.platform}/${process.arch}`,
    `node=${process.version}`,
  ];
  try {
    const dir = path.resolve(__dirname, "..", "node_modules", "@anthropic-ai");
    const entries = fs.readdirSync(dir);
    parts.push(`@anthropic-ai=${entries.join(",")}`);
  } catch {
    // 忽略:诊断信息尽力而为
  }
  return parts.join(" ");
}

let cached: BinaryCheck | null = null;

/**
 * 服务运行期获取已验证过的二进制路径。必须先在 server 启动时 await verifyBinary()
 * 并通过 setCachedBinary 写入;否则此函数抛错,防止任何请求在未校验状态下到达 SDK。
 */
export function getBinaryPath(): string {
  if (!cached) throw new Error("binary not verified yet; call verifyBinary() at boot");
  return cached.path;
}

export function setCachedBinary(check: BinaryCheck): void {
  cached = check;
}
