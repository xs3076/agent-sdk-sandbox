import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";

const execFileP = promisify(execFile);

/**
 * 在 linux 上区分 glibc / musl。Node 自带的 process.report 在 glibc 系统会暴露
 * glibcVersionRuntime;musl(Alpine)系统该字段为空字符串或缺失。这是 detect-libc
 * 之外、无需额外依赖的官方判定方式。
 */
function detectLinuxLibc(): "musl" | "glibc" {
  type Header = { glibcVersionRuntime?: string };
  const header = (process.report?.getReport() as { header?: Header } | undefined)?.header;
  return header?.glibcVersionRuntime ? "glibc" : "musl";
}

/**
 * 当前 Node 进程对应的 SDK 原生子包名(与 SDK 内部 F5() 解析逻辑一致)。
 *  - linux:           @anthropic-ai/claude-agent-sdk-linux-${arch}[-musl]
 *  - darwin / win32:  @anthropic-ai/claude-agent-sdk-${platform}-${arch}
 */
export function nativePackageName(): string {
  const { platform, arch } = process;
  if (platform === "linux") {
    return detectLinuxLibc() === "musl"
      ? `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`
      : `@anthropic-ai/claude-agent-sdk-linux-${arch}`;
  }
  return `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
}

/**
 * 解析当前平台对应的 claude 可执行文件绝对路径。
 *
 * 不走 SDK 的 require.resolve 兜底链(musl 失败回落 glibc),那条链在 Alpine 上
 * 会让一个 glibc 二进制被 spawn,kernel 找不到动态链接器后回 ENOENT,SDK 误报
 * "native binary not found"。这里强制只用当前平台的子包,任何不匹配都立即抛错。
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
      `${binPath} --version failed (likely libc/arch mismatch on this host). ${diagnostics()}`,
      { cause: err as Error },
    );
  }
}

function diagnostics(): string {
  const parts: string[] = [
    `platform=${process.platform}/${process.arch}`,
    `node=${process.version}`,
  ];
  if (process.platform === "linux") parts.push(`libc=${detectLinuxLibc()}`);
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
