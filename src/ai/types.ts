// ============================================================
// AI 层核心类型 —— my-eval-agent 的「通用语言」
//
// 三个关键契约（对应学习计划检查点三问）：
//   ToolCall  ：模型→代码世界的唯一动作通道（3 字段）
//   LLMEvent ：流式事件的 5 种形态
//   Model    ：模型统一接口（stream 是唯一干活方法）
//
// 有意砍掉（相对 my-easy-pi）：图片块 / thinking / 多 stopReason
// ============================================================

/** 模型基本信息（registry 菜单用的条目） */
export interface ModelInfo {
  id: string
  provider: string
  description?: string
}

/** 工具调用：模型说「我要调工具」的统一形态 */
export interface ToolCall {
  id: string      // 回传结果时对号入座
  name: string    // 调哪个工具
  args: unknown   // 参数（已 JSON.parse 的对象）
}

/** 发给 LLM 的消息（三角色；格式差异由 Provider 消化） */
export type LLMMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'toolResult'; toolCallId: string; content: string; isError?: boolean }

/** LLM 流式响应的事件（比 my-easy-pi 少一种 thinking_delta） */
export type LLMEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; id: string; name: string; args: unknown }
  | { type: 'tool_call_delta'; id: string; delta: string }
  | { type: 'error'; message: string }
  | { type: 'done'; stopReason?: 'end_turn' | 'tool_use' }

/** LLM 能看到的工具定义（schema 就是普通 JSON 对象，不引 typebox） */
export interface ModelTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** 调用 LLM 的完整上下文 */
export interface ModelContext {
  systemPrompt: string
  messages: LLMMessage[]
  tools?: ModelTool[]
}

export interface StreamOptions {
  signal?: AbortSignal
  maxTokens?: number
}

/** 模型统一接口：上层只认这个「插座形状」 */
export interface Model {
  id: string
  provider: string
  stream(context: ModelContext, options?: StreamOptions): AsyncIterable<LLMEvent>
  supportsTools(): boolean
}

export interface ProviderConfig {
  apiKey: string
  baseUrl?: string
}

/** Provider 工厂：用配置造一个 Provider 实例 */
export interface ProviderFactory {
  create(config: ProviderConfig): {
    name: string
    listModels(): ModelInfo[]
    createModel(modelId: string): Model | null
  }
}
