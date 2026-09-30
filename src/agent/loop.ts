// ============================================================
// Agent Loop —— my-eval-agent 的核心循环（M2 裸循环版）
//
// 对照 my-easy-pi 的 loop.ts（读码阶段二的骨架），本版有意砍掉：
//   queue/steering（MVP 单任务跑完即止）
//   permission 权限系统（评测场景不需要）
//   三个钩子（M4 再加：transformContext/beforeToolCall/afterToolCall）
//
// 主循环三出口（阶段二检验过的知识点）：
//   ① 模型不再要工具 → break
//   ② 所有工具返回 terminate:true → break
//   ③ prompt 入口 isStreaming 检查 → 拒绝并发
// ============================================================

import type {
  Model, ModelContext, LLMMessage, LLMEvent, ToolCall,
} from '../ai/types.js'
import type { AgentEvent, AgentMessage, AgentTool, ToolResult } from './types.js'
import { generateId } from './types.js'
import { ToolRegistry } from '../tools/registry.js'

export interface AgentLoopConfig {
  systemPrompt: string
  model: Model
  tools: AgentTool[]
  /** 可选：订阅生命周期事件（日志/UI 用） */
  onEvent?: (event: AgentEvent) => void
}

export class Agent {
  readonly model: Model
  readonly systemPrompt: string
  messages: AgentMessage[] = []
  isStreaming = false
  errorMessage: string | undefined

  private toolRegistry = new ToolRegistry()
  private onEvent?: (event: AgentEvent) => void
  private abortController: AbortController | null = null

  constructor(config: AgentLoopConfig) {
    this.model = config.model
    this.systemPrompt = config.systemPrompt
    this.onEvent = config.onEvent
    for (const tool of config.tools) {
      this.toolRegistry.registerTool(tool)
    }
  }

  /** 入口：发一条用户消息，跑完整循环 */
  async prompt(text: string): Promise<void> {
    if (this.isStreaming) {
      throw new Error('Agent 正在处理中，不能并发 prompt')
    }
    this.abortController = new AbortController()
    this.messages.push({
      id: generateId(), role: 'user', content: text, createdAt: Date.now(),
    })
    this.isStreaming = true
    this.emit({ type: 'agent_start' })
    try {
      await this.runLoop()
    } finally {
      this.isStreaming = false
      this.emit({ type: 'agent_end' })
    }
  }

  /** 取消（只断流；工具要不要响应 signal 是工具自己的事） */
  abort(): void {
    this.abortController?.abort()
    this.isStreaming = false
  }

  // ── 核心循环 ──────────────────────────────────────────────

  private async runLoop(): Promise<void> {
    while (true) {
      this.emit({ type: 'turn_start' })

      // 1. Agent 消息 → LLM 消息
      const llmMessages = this.convertToLlm()

      // 2. 组装上下文（工具清单每轮现发，运行时注册新工具下一轮生效）
      const context: ModelContext = {
        systemPrompt: this.systemPrompt,
        messages: llmMessages,
        tools: this.toolRegistry.listTools().map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
      }

      // 3. 调模型，边收事件边拼装
      const { content, toolCalls } = await this.processLLMStream(context)

      // 4. assistant 消息入历史（记账：模型说了什么、要了什么工具）
      this.messages.push({
        id: generateId(), role: 'assistant', content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        createdAt: Date.now(),
      })

      // 5. 出口①：没有工具调用 → 模型说完了 → 收工
      if (toolCalls.length === 0) {
        this.emit({ type: 'turn_end' })
        break
      }

      // 6. 执行工具
      const toolResults = await this.executeToolCalls(toolCalls)

      // 7. toolResult 入历史（先记账再判 terminate，历史才完整）
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        const result = toolResults[i]
        this.messages.push({
          id: generateId(), role: 'toolResult',
          content: result.content.map((c) => c.text).join('\n'),
          toolCallId: tc.id,
          isError: result.isError,
          createdAt: Date.now(),
        })
      }

      // 8. 出口②：所有工具都说「到这为止」
      if (toolResults.every((r) => r.terminate)) {
        this.emit({ type: 'turn_end' })
        break
      }
      // ↺ 回到顶部：带着工具结果再问模型
    }
  }

  // ── 流式事件处理 + 工具参数拼装 ──────────────────────────

  private async processLLMStream(context: ModelContext): Promise<{
    content: string
    toolCalls: ToolCall[]
  }> {
    let content = ''
    const toolCalls: ToolCall[] = []
    let currentToolCall: Partial<ToolCall> | null = null
    let toolCallArgs = '' // 缓冲罐：碎片不是合法 JSON，攒到最后一起 parse

    for await (const event of this.model.stream(context, {
      signal: this.abortController?.signal,
    })) {
      switch (event.type) {
        case 'text_delta':
          content += event.delta
          this.emit({ type: 'message_update', content })
          break

        case 'tool_call_start':
          currentToolCall = { id: event.id, name: event.name }
          toolCallArgs = ''
          // 非流式路径：args 已完整（如部分网关一次性给全）→ 直接入列
          if (event.args && typeof event.args === 'object'
              && Object.keys(event.args).length > 0) {
            toolCalls.push({ id: event.id, name: event.name, args: event.args })
            currentToolCall = null
          }
          break

        case 'tool_call_delta':
          toolCallArgs += event.delta // 拼接核心：片片 +=（my-easy-pi loop.ts:321）
          break

        case 'error':
          this.errorMessage = event.message
          content += `\n[模型错误: ${event.message}]`
          break

        case 'done':
          // 收官：把缓冲罐里的碎片整体 parse
          if (currentToolCall && toolCallArgs) {
            try {
              toolCalls.push({
                id: currentToolCall.id!,
                name: currentToolCall.name!,
                args: JSON.parse(toolCallArgs),
              })
            } catch {
              // parse 失败兜底：原始字符串当 args（粗但保证循环转得下去）
              toolCalls.push({
                id: currentToolCall.id!,
                name: currentToolCall.name!,
                args: toolCallArgs,
              })
            }
            currentToolCall = null
            toolCallArgs = ''
          }
          break
      }
    }
    return { content, toolCalls }
  }

  // ── 工具执行 ─────────────────────────────────────────────

  private async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = []
    for (const tc of toolCalls) {
      const tool = this.toolRegistry.getTool(tc.name)

      // 工具不存在 → isError 结果（模型能看到并换姿势）
      if (!tool) {
        results.push({
          content: [{ type: 'text', text: `工具不存在: ${tc.name}` }],
          isError: true,
        })
        continue
      }

      this.emit({ type: 'tool_execution_start', toolName: tc.name, args: tc.args })
      try {
        const result = await tool.execute(
          tc.id,
          (tc.args ?? {}) as Record<string, unknown>,
          this.abortController?.signal || new AbortController().signal,
        )
        results.push(result)
        this.emit({ type: 'tool_execution_end', toolName: tc.name, isError: !!result.isError })
      } catch (e) {
        // 兜底：工具崩了 = 模型收到一条写着报错信息的 toolResult，循环不炸
        const msg = e instanceof Error ? e.message : String(e)
        results.push({
          content: [{ type: 'text', text: `工具执行失败: ${msg}` }],
          isError: true,
        })
        this.emit({ type: 'tool_execution_end', toolName: tc.name, isError: true })
      }
    }
    return results
  }

  // ── 消息转换 ─────────────────────────────────────────────

  private convertToLlm(): LLMMessage[] {
    return this.messages.map((m): LLMMessage => {
      if (m.role === 'user') return { role: 'user', content: m.content }
      if (m.role === 'assistant') {
        return { role: 'assistant', content: m.content, toolCalls: m.toolCalls }
      }
      return {
        role: 'toolResult',
        toolCallId: m.toolCallId!,
        content: m.content,
        isError: m.isError,
      }
    })
  }

  private emit(event: AgentEvent): void {
    this.onEvent?.(event)
  }
}
