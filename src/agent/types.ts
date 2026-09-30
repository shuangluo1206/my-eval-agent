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

export function generateId(): string {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
