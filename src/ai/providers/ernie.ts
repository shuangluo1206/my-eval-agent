// ============================================================
// OneAPI 网关 Provider —— my-eval-agent 的「耳朵和嘴」
//
// 网关说纯 OpenAI 方言，所以本文件只有三样私货：
//   ① baseUrl（走 .env 配置，不入仓库）
//   ② 模型菜单（GLM-5.3 主力 + DeepSeek-V4-Pro 对照）
//   ③ Bearer 鉴权头
// 翻译逻辑全部复用 openai-compat.ts —— adapter 的本职。
//
// 已知模型脾气（bench 实测，将来做降级触发条件）：
//   GLM-5.3        write_file 偶发丢 path
//   DeepSeek-V4-Pro write_file 偶发参数全空
// ============================================================

import type {
  ProviderFactory, Model, ModelContext, ModelInfo,
  LLMEvent, StreamOptions,
} from '../types.js'
import { fetchWithRetry } from '../retry.js'
import { readSSEStream } from '../sse.js'
import { buildOpenAIRequestBody, convertOpenAIEvent } from '../openai-compat.js'

export const OneApiProvider: ProviderFactory = {
  create(config) {
    const apiKey = config.apiKey
    const baseUrl = (config.baseUrl || '').replace(/\/$/, '')

    return {
      name: 'oneapi',

      listModels(): ModelInfo[] {
        return [
          { id: 'GLM-5.3', provider: 'oneapi', description: '主力模型（日常推理与工具调用）' },
          { id: 'DeepSeek-V4-Pro', provider: 'oneapi', description: '对照/降级模型' },
        ]
      },

      createModel(modelId: string): Model | null {
        const supported = this.listModels().find((m) => m.id === modelId)
        if (!supported) return null
        return new GatewayModel(modelId, apiKey, baseUrl)
      },
    }
  },
}

class GatewayModel implements Model {
  id: string
  provider = 'oneapi'

  constructor(
    id: string,
    private apiKey: string,
    private baseUrl: string,
  ) {
    this.id = id
  }

  supportsTools(): boolean {
    // 菜单里的两个模型均声明支持工具调用（M1 冒烟实测后此结论才生效）
    return true
  }

  async *stream(context: ModelContext, options?: StreamOptions): AsyncIterable<LLMEvent> {
    if (!this.baseUrl || !this.apiKey) {
      yield { type: 'error', message: '缺少网关配置：请检查 .env 的 EVAL_AGENT_BASE_URL / EVAL_AGENT_API_KEY' }
      return
    }

    const body = buildOpenAIRequestBody(this.id, context, this.supportsTools())

    let response: Response
    try {
      response = await fetchWithRetry(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      })
    } catch (e) {
      yield { type: 'error', message: `网络请求失败: ${e instanceof Error ? e.message : String(e)}` }
      return
    }

    if (!response.ok) {
      const errorText = await response.text()
      yield { type: 'error', message: `网关错误 (${response.status}): ${errorText.slice(0, 500)}` }
      return
    }

    // 边读边转发：每收到一个 chunk 就 yield，消费方才能流式输出
    for await (const event of readSSEStream(response, convertOpenAIEvent, options?.signal)) {
      yield event
    }
  }
}
