// ============================================================
// ModelRouter —— 多模型路由（可选亮点）
//
// 实现 Model 接口 = 一个「插座转接头」：Agent 照常拔插，
// 根本不知道背后站着两个模型。
//
// 路由策略（设计稿拍板：GLM-5.3 主力 + DeepSeek-V4-Pro 降级）：
//   ① 当轮无缝切换：主力开局就报错（一个字还没吐）→ 本轮直接
//      改用备用模型跑完，错误事件不往外传，Agent 无感知。
//      注意：这不算降级——可能是偶发抖动，下轮主力还有机会。
//   ② 质量降级：主力产出「畸形工具调用」（write_file 丢 path，
//      bench 实测老毛病）→ 连败计数 +1 → 达到阈值永久降级到备用。
//   ③ 主力流中途报错：事件已经放行没法收回，只计数，下轮生效。
//
// routingLog：每次路由决策记一行，演示/调试用（面试的「可视化证据」）。
// ============================================================

import type { Model, ModelContext, LLMEvent, StreamOptions } from './types.js'

export interface ModelRouterOptions {
  /** 主力连续失败几轮触发永久降级（默认 1：write_file 丢 path 一票否决） */
  maxFailStreak?: number
}

export class ModelRouter implements Model {
  readonly primary: Model
  readonly fallback: Model

  /** 路由决策日志（谁在干活、为什么换人） */
  readonly routingLog: string[] = []

  /** 上一轮实际干活的模型（当轮无缝切换不改变 degraded，用这个看真实归属） */
  lastServedBy: Model

  private degraded = false
  private failStreak = 0
  private readonly maxFailStreak: number

  constructor(primary: Model, fallback: Model, options: ModelRouterOptions = {}) {
    this.primary = primary
    this.fallback = fallback
    this.lastServedBy = primary
    this.maxFailStreak = options.maxFailStreak ?? 1
  }

  /** 当前实际在干活的模型 */
  get activeModel(): Model {
    return this.degraded ? this.fallback : this.primary
  }

  // Model 接口的身份字段：跟着当前干活的模型走
  get id(): string {
    return this.activeModel.id
  }

  get provider(): string {
    return this.activeModel.provider
  }

  supportsTools(): boolean {
    return this.activeModel.supportsTools()
  }

  async *stream(context: ModelContext, options?: StreamOptions): AsyncIterable<LLMEvent> {
    // 已降级：直接用备用（备用出错只记日志，没地方再降）
    if (this.degraded) {
      this.lastServedBy = this.fallback
      yield* this.watch(this.fallback, this.fallback.stream(context, options))
      return
    }

    // 未降级：先偷看主力的第一个事件，决定当轮用谁
    const primaryIter = this.primary.stream(context, options)[Symbol.asyncIterator]()
    const first = await primaryIter.next()
    if (first.done) return

    if (first.value.type === 'error') {
      // ① 当轮无缝切换：错误不外传，本轮交给备用（不算降级）
      this.routingLog.push(
        `主力 ${this.primary.id} 开局报错（${first.value.message.slice(0, 60)}）`
        + ` → 当轮无缝切 ${this.fallback.id}（下轮主力继续）`,
      )
      this.lastServedBy = this.fallback
      yield* this.watch(this.fallback, this.fallback.stream(context, options))
      return
    }

    // 主力正常开局：把偷看到的第一个事件塞回去，整轮带监视放行
    this.lastServedBy = this.primary
    const replay = async function* (): AsyncIterable<LLMEvent> {
      yield first.value
      yield* { [Symbol.asyncIterator]: () => primaryIter }
    }()
    yield* this.watch(this.primary, replay)
  }

  // ── 监视器：事件原样放行，赛后结算要不要降级 ─────────────

  private async *watch(model: Model, stream: AsyncIterable<LLMEvent>): AsyncIterable<LLMEvent> {
    const isPrimary = model === this.primary

    // 拼工具参数的小缓冲（只盯最后一个工具调用，MVP 够用）
    let inCall = false
    let callName = ''
    let callArgs = ''
    let fullArgs: unknown = null
    let errorThisTurn = false

    for await (const event of stream) {
      // ── 监视：只看不改，事件原样放行 ──
      switch (event.type) {
        case 'error':
          errorThisTurn = true
          break
        case 'tool_call_start':
          inCall = true
          callName = event.name
          callArgs = ''
          fullArgs = (event.args && typeof event.args === 'object'
            && Object.keys(event.args).length > 0) ? event.args : null
          break
        case 'tool_call_delta':
          callArgs += event.delta
          break
        case 'done':
          if (inCall) {
            this.judgeToolCall(callName, fullArgs, callArgs)
            inCall = false
          }
          break
      }
      yield event
    }

    // ── 赛后结算（只结算主力；备用出错没地方再降，只记日志）──
    if (!isPrimary) {
      if (errorThisTurn) {
        this.routingLog.push(`备用 ${this.fallback.id} 也报错了（无更低的档可降）`)
      }
      return
    }

    if (errorThisTurn) {
      this.failStreak++
      this.routingLog.push(`主力 ${this.primary.id} 流中途报错，连败 ${this.failStreak}`)
    }

    if (this.failStreak >= this.maxFailStreak && !this.degraded) {
      this.degraded = true
      this.routingLog.push(
        `主力连败 ${this.failStreak} 轮（阈值 ${this.maxFailStreak}）`
        + ` → 永久降级到 ${this.fallback.id}`,
      )
    }
  }

  // ── 质量缺陷判定：write_file 丢 path（bench 实测的模型脾气）──

  private judgeToolCall(name: string, fullArgs: unknown, argsBuf: string): void {
    if (name !== 'write_file') return

    let args: Record<string, unknown> | null = null
    if (fullArgs && typeof fullArgs === 'object') {
      args = fullArgs as Record<string, unknown>
    } else {
      try {
        args = JSON.parse(argsBuf) as Record<string, unknown>
      } catch {
        // 缓冲连 JSON 都不是 → 参数全空/半截，DeepSeek 式的坑
        this.failStreak++
        this.routingLog.push(`主力 write_file 参数残缺（连 JSON 都拼不出），连败 ${this.failStreak}`)
        return
      }
    }

    const path = (args as { path?: unknown }).path
    if (!path || typeof path !== 'string' || path.length === 0) {
      this.failStreak++
      this.routingLog.push(`主力 write_file 丢 path（bench 实测老毛病），连败 ${this.failStreak}`)
    }
  }
}
