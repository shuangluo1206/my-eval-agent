// ============================================================
// SSE 通用拆包 —— 只管拆快递，不管内容是谁家的
//
// SSE 格式：HTTP 长连接里，服务端一行行推文本，每行以 "data: " 开头，
// 流结束推一行 "data: [DONE]"。
// 本模块只做三件事：按行拆、剥 data: 前缀、JSON.parse 后交给回调翻译。
// 边读边 yield（不整体缓冲），消费方才能打字机式输出。
// ============================================================

/** 翻译回调：收到一个已 parse 的 SSE 数据块，返回 0~n 个上层事件 */
export type SSECallback<T> = (data: Record<string, unknown>) => T[]

export async function* readSSEStream<T>(
  response: Response,
  convert: SSECallback<T>,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // 网络 chunk 可能半行半行地到，所以按已完整的行处理
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue // 忽略注释行/空行

        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return

        let data: unknown
        try {
          data = JSON.parse(payload)
        } catch {
          continue // 非 JSON 行直接跳过
        }
        for (const item of convert(data as Record<string, unknown>)) {
          yield item
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
