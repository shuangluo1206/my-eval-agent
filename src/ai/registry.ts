// ============================================================
// ModelRegistry —— 模型注册表（Map + 工厂）
//
// 上层（将来的 loop）只通过本注册表拿模型，
// 根本不知道底下是哪家 Provider —— 换模型不动其他代码。
// ============================================================

import type { ProviderFactory, ProviderConfig, Model, ModelInfo } from './types.js'

export class ModelRegistry {
  private providers = new Map<string, ProviderFactory>()

  /** 注册一个 Provider 工厂 */
  setProvider(name: string, factory: ProviderFactory): void {
    this.providers.set(name, factory)
  }

  /** 按名字取 Provider，再用配置造实例 */
  getProvider(name: string, config: ProviderConfig) {
    const factory = this.providers.get(name)
    if (!factory) return null
    return factory.create(config)
  }

  /** 列出所有 Provider 的全部模型（供 CLI 选择） */
  listModels(provider?: string): ModelInfo[] {
    const result: ModelInfo[] = []
    for (const [name, factory] of this.providers) {
      if (provider && name !== provider) continue
      // 无 key 也能列菜单（菜单是静态的）
      result.push(...factory.create({ apiKey: '' }).listModels())
    }
    return result
  }

  /** 一步到位：按 provider 名 + 模型 id 拿 Model 实例 */
  getModel(providerName: string, modelId: string, config: ProviderConfig): Model | null {
    const p = this.getProvider(providerName, config)
    if (!p) return null
    return p.createModel(modelId)
  }
}
