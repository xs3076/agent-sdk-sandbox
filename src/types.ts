// Node Agent 服务的请求/响应类型定义。

/**
 * POST /agent/run 请求体。
 *
 * Agent 对 provider 无关——baseUrl / authToken 由调用方传入,
 * 支持 OpenRouter / BigModel(智谱)/ Bedrock 等任意 Anthropic-skin 后端。
 */
export interface AgentRunRequest {
  /** 工作目录(SDK 的 cwd,必须存在且是目录;路径合法性由部署边界——容器/VM——负责) */
  workDir: string;
  /** 本轮 prompt(首次为指令,后续为追问) */
  prompt: string;
  /** 多轮对话时传入,等于上一次 SDK 返回的 session_id;首次为空 */
  sessionId?: string;

  /**
   * LLM 网关 base URL,如:
   *  - OpenRouter:   https://openrouter.ai/api(注意不带 /v1)
   *  - BigModel(智谱):https://open.bigmodel.cn/api/anthropic
   */
  baseUrl: string;
  /** 网关鉴权 token,每次请求注入,不在镜像中预置 */
  authToken: string;

  /** 主模型 */
  model: string;
  /** 小模型(SDK 用于快速操作) */
  smallModel?: string;

  /**
   * 透传给 SDK 的 allowedTools。
   * 注意:当前 runAgent 以 bypassPermissions + allowDangerouslySkipPermissions 启动,
   * SDK 会跳过绝大多数工具的权限确认,allowedTools 不构成"工具白名单"安全边界——
   * 真正的隔离依赖部署侧的沙箱(容器/VM)。
   *
   * 但服务侧硬编码了一条 PreToolUse hook(见 agent.ts 的 denyGitWriteHook),
   * 会强制拒绝改写仓库历史/远端的 git 子命令
   * (commit/commit-tree/push/tag/update-ref/fast-import/replace/notes),
   * 该规则不受 allowedTools / disallowedTools / permissionMode 影响。
   */
  allowedTools?: string[];
  /** 最大轮数,默认 50 */
  maxTurns?: number;
}
