// Node Agent 服务的请求/响应类型定义。

/**
 * Spring Boot 调用 POST /agent/review 的请求体。
 *
 * Agent 对 provider 无关——baseUrl / authToken 由调用方传入,
 * 支持 OpenRouter / BigModel(智谱)/ Bedrock 等任意 Anthropic-skin 后端。
 */
export interface ReviewRequest {
  /** 工作目录(沙箱内的仓库克隆路径,如 /workspace/repo) */
  workDir: string;
  /** 本轮 prompt(首次为评审指令,后续为追问) */
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
}

export type { CloneRequest, CloneResult } from "./clone";
