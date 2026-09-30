// ============================================================
// OpenAI 兼容层 —— 共享的请求体构建和事件转换
//
// OneAPI 网关说的是纯 OpenAI 方言，所以翻译逻辑一份通吃：
//   buildOpenAIRequestBody ：出（内部格式 → OpenAI 请求体）
//   convertOpenAIEvent    ：入（OpenAI 流式 chunk → 统一 LLMEvent）
//
// 已知的坑（my-easy-pi 读码教训）：
//   同一 chunk 可能同时带 content 和 tool_calls 增量，
//   两者都要消费，不能因先取 content 就提前 return。
// ============================================================

import type { ModelContext, LLMEvent } from './types.js'

export function buildOpenAIRequestBody(
  modelId: string,
  context: ModelContext,
  supportsTools: boolean,
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [
    { role: 'system', content: context.systemPrompt },
  ]

  for (const msg of context.messages) {
    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content })
    } else if (msg.role === 'assistant') {
      const m: Record<string, unknown> = { role: 'assistant', content: msg.content }
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        // 注意：arguments 要字符串化（JSON.stringify）
        m.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args ?? {}),
          },
        }))
      }
      messages.push(m)
    } else {
      // toolResult → OpenAI 的 role:'tool'，靠 tool_call_id 对号入座
      messages.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.content,
      })
    }
  }

  const body: Record<string, unknown> = {
    model: modelId,
    stream: true,
    max_tokens: 8192,
    messages,
  }

  if (context.tools && context.tools.length > 0 && supportsTools) {
    body.tools = context.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }))
  }
  return body
}

export function convertOpenAIEvent(data: Record<string, unknown>): LLMEvent[] {
  const choices = data.choices as Array<Record<string, unknown>> | undefined
  if (!choices || choices.length === 0) return []

  const delta = choices[0].delta as Record<string, unknown> | undefined
  const finishReason = choices[0].finish_reason as string | null | undefined
  const events: LLMEvent[] = []

  // 流结束（工具结束优先判别）
  if (finishReason) {
    events.push({
      type: 'done',
      stopReason: finishReason === 'tool_calls' ? 'tool_use' : 'end_turn',
    })
    return events
  }
  if (!delta) return events

  // 文本内容（可能与本 chunk 的工具增量并存，不提前 return）
  if (delta.content) {
    events.push({ type: 'text_delta', delta: delta.content as string })
  }

  // 工具调用：id 出现 = 新工具开始；只有 arguments = 参数碎片
  const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined
  if (toolCalls && toolCalls.length > 0) {
    const tc = toolCalls[0]
    const fn = tc.function as Record<string, unknown> | undefined
    if (tc.id) {
      // 第一个 chunk 带 id；部分网关会连着给完整 args，能 parse 就直接给
      const argsStr = fn?.arguments as string | undefined
      if (argsStr && argsStr !== 'null' && argsStr !== '') {
        try {
          events.push({
            type: 'tool_call_start',
            id: tc.id as string,
            name: (fn?.name as string) || '',
            args: JSON.parse(argsStr),
          })
          return events
        } catch {
          // 参数不完整，走流式拼装
        }
      }
      events.push({
        type: 'tool_call_start',
        id: tc.id as string,
        name: (fn?.name as string) || '',
        args: {},
      })
    } else if (fn?.arguments) {
      events.push({
        type: 'tool_call_delta',
        id: '',
        delta: fn.arguments as string,
      })
    }
  }
  return events
}
