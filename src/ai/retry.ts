// ============================================================
// fetch + 指数退避重试
//
// 只重试「值得重试」的失败：5xx / 429（限流）/ 网络抖动。
// 4xx（如 401 key 错误）重试也没用，直接返回让上层报错。
// ============================================================

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 2,
): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init)
      // 服务端错误或限流 → 退避后重试
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        await sleep(1000 * 2 ** attempt) // 1s, 2s
        continue
      }
      return res
    } catch (e) {
      lastError = e
      // 用户主动取消不重试，立刻抛
      if (init.signal?.aborted) throw e
      if (attempt < retries) await sleep(1000 * 2 ** attempt)
    }
  }
  throw lastError
}
