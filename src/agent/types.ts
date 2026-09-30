// ============================================================
// Agent 层类型 —— 在 ai/types.ts 基础上扩展
//
// 类型递进（同 my-easy-pi）：
//   ai/types.ts    → Tool（纯类型，已含）
//   agent/types.ts → AgentTool（+execute 执行能力）
// 砍掉：ToolDefinition 的 UI 属性（icon/category/dangerLevel）
// ============================================================

import type { ToolCall } from '../ai/types.js'

/** 工具执行结果（execute 必须返回这个形状） */
export interface ToolResult {
  content: { type: 'text'; text: string }[]
  /** 设为 true 会终止整个循环 */
  terminate?: boolean
  /** 设为 true 表示工具执行出错（模型能看到并重试） */
  isError?: boolean
}

/** Agent 工具 = 名字 + 参数 schema + 执行函数（阶段三公式） */
export interface AgentTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    /** 流式回传：长任务（如 run_eval 跑几分钟）边跑边报进度 */
    onUpdate?: (chunk: string) => void,
  ): Promise<ToolResult>
}

/** Agent 内部消息（比 LLMMessage 多个 id，便于 UI/日志追踪） */
export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'toolResult'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  isError?: boolean
  createdAt: number
}

/** Agent 生命周期事件（订阅用） */
export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'turn_start' }
  | { type: 'message_update'; content: string }
  | { type: 'tool_execution_start'; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolName: string; chunk: string }
  | { type: 'tool_execution_end'; toolName: string; isError: boolean }
  | { type: 'turn_end' }
  | { type: 'agent_end' }

// ── 三钩子（M4）──
// 钩子 = 循环里预留的「插队口」，不改变循环本身，垂直逻辑从外面插进来。
// 对照 my-easy-pi loop.ts:39-43 同名签名。

/** beforeToolCall 的入参：模型想调什么工具、带什么参数、当前历史 */
export interface ToolCallContext {
  toolCall: ToolCall
  args: Record<string, unknown>
  messages: AgentMessage[]
}

/** beforeToolCall 的返回：block=true 拦下这次调用，reason 会作为 isError 结果回给模型 */
export interface BlockResult {
  block: boolean
  reason?: string
}

/** afterToolCall 的入参：刚跑完的调用 + 结果 + 当前历史 */
export interface ToolCallResultContext {
  toolCall: ToolCall
  result: ToolResult
  messages: AgentMessage[]
}

/** afterToolCall 的返回：terminate=true 提前收工（出口②） */
export interface AfterToolCallResult {
  terminate?: boolean
}

/** 三钩子集合（AgentLoopConfig 可选字段） */
export interface AgentHooks {
  /** 每轮发给模型前：改写/瘦身历史（防上下文爆炸） */
  transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]>
  /** 工具执行前：前置校验，可拦截 */
  beforeToolCall?: (ctx: ToolCallContext) => Promise<BlockResult | undefined>
  /** 工具执行后：后处理，可提前终止循环 */
  afterToolCall?: (ctx: ToolCallResultContext) => Promise<AfterToolCallResult | undefined>
}

export function generateId(): string {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
