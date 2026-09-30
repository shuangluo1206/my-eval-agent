// ============================================================
// 评测垂直化三钩子（M4）—— 本项目的差异化所在
//
// 循环（loop.ts）是通用的，一个字不懂「评测」；
// 垂直智能全在这三个钩子里，从外面插进循环：
//   ① createTrajectorySlimmer  轨迹瘦身（防上下文爆炸）
//   ② evalBeforeToolCall       前置校验（拦住瞎调）
//   ③ createScoreThresholdTerminator  达标收尾（省 token）
// ============================================================

import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentHooks, AgentMessage } from './types.js'
import { generateId } from './types.js'

// ── 钩子①：轨迹瘦身 ────────────────────────────────────────
//
// read_trials 的输出动辄几百行，多跑几轮上下文就爆。
// 做法：历史超过 keep 条时，把旧的整轮砍掉，换成一条摘要。
// ⚠️ 关键坑：不能从任意位置砍——assistant(带 toolCalls) 被砍掉
// 而它的 toolResult 留下来，会成为「孤儿结果」，网关直接 422。
// 所以截断点必须挪到「非 toolResult 边界」，整轮整轮地砍。

export function createTrajectorySlimmer(options: { keep?: number } = {}): NonNullable<AgentHooks['transformContext']> {
  const keep = options.keep ?? 20

  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    if (messages.length <= keep) return messages

    // 从倒数第 keep 条往前挪，直到落在非 toolResult 上（整轮边界）
    let cut = messages.length - keep
    while (cut > 0 && messages[cut].role === 'toolResult') cut--
    if (cut <= 0) return messages

    const dropped = messages.slice(0, cut)
    const toolCallCount = dropped.filter((m) => m.role === 'assistant' && m.toolCalls).length
    const errorCount = dropped.filter((m) => m.role === 'toolResult' && m.isError).length
    // 找原始任务时跳过上一轮的摘要（不然摘要套摘要，越滚越乱）
    const firstTask = dropped.find(
      (m) => m.role === 'user' && !m.content.startsWith('（历史已瘦身'),
    )?.content ?? ''
    const taskShort = firstTask.length > 60 ? firstTask.slice(0, 60) + '…' : firstTask

    const summary: AgentMessage = {
      id: generateId(),
      role: 'user',
      content: `（历史已瘦身：截断 ${dropped.length} 条旧消息，`
        + `含 ${toolCallCount} 次工具调用、${errorCount} 条错误结果。`
        // 原始任务还在保留窗口里时（没被砍）就不用重复带上
        + (firstTask ? `原始任务：${taskShort}。` : '')
        + `完整轨迹在磁盘上，可用 read_trials 复盘。）`,
      createdAt: Date.now(),
    }

    return [summary, ...messages.slice(cut)]
  }
}

// ── 钩子②：前置校验 ────────────────────────────────────────
//
// 两条规则（设计稿定的）：
//   a. read_trials 的 trial_dir 不存在 → 拦截，提示先跑 run_eval
//      （不然模型拿幻觉路径瞎试，一失败就是连环重试）
//   b. run_eval 正在跑时禁止再发 run_eval（防并发写同一 trials 目录）

// 注：锁状态放在共享对象里（beforeToolCall 上锁、afterToolCall 解锁），
// 两个钩子必须拿到同一个 state 才有效——createEvalHooks 负责穿线。

interface RunEvalLock {
  running: boolean
}

export function createEvalBeforeToolCall(lock: RunEvalLock = { running: false }): NonNullable<AgentHooks['beforeToolCall']> {
  return async (ctx) => {
    const { toolCall, args } = ctx

    if (toolCall.name === 'run_eval') {
      if (lock.running) {
        return { block: true, reason: '已有 run_eval 在跑，等它结束（防并发写 trials 目录）' }
      }
      lock.running = true // 上锁；afterToolCall 里解锁
      return undefined
    }

    if (toolCall.name === 'read_trials') {
      const dirOrPath = resolve(String(args.trial_dir ?? ''))
      if (!existsSync(dirOrPath)) {
        return {
          block: true,
          reason: `轨迹目录不存在: ${dirOrPath}。请先用 run_eval 跑一轮评测拿到真实轨迹目录`,
        }
      }
      // 目录存在还得确认里面有 trajectory.jsonl（空目录照样拦）
      if (statSync(dirOrPath).isDirectory() && !existsSync(resolve(dirOrPath, 'trajectory.jsonl'))) {
        return { block: true, reason: `目录里没有 trajectory.jsonl: ${dirOrPath}` }
      }
    }

    return undefined
  }
}

// ── 钩子③：达标收尾 ────────────────────────────────────────
//
// run_eval 分数 ≥ 阈值 → terminate，循环出口②提前收工。
// 省的是「模型看完高分还得煞有介事总结一轮」的 token。
// 同时负责给 run_eval 的锁解锁（成功失败都解）。

export function createScoreThresholdTerminator(
  threshold = 80,
  lock?: RunEvalLock,
): NonNullable<AgentHooks['afterToolCall']> {
  return async (ctx) => {
    // 无论分数如何，run_eval 跑完就解锁
    if (ctx.toolCall.name === 'run_eval' && lock) {
      lock.running = false
    }

    if (ctx.toolCall.name !== 'run_eval' || ctx.result.isError) return undefined

    // 从工具返回文本里抠分数（run_eval 的输出形如「得分: 87/99」）
    const text = ctx.result.content.map((c) => c.text).join('\n')
    const match = text.match(/得分:\s*(\d+(?:\.\d+)?)/)
    if (!match) return undefined

    const score = Number(match[1])
    if (score >= threshold) {
      return { terminate: true }
    }
    return undefined
  }
}

// ── 组装成 AgentHooks ─────────────────────────────────────

export function createEvalHooks(options: {
  keep?: number
  scoreThreshold?: number
} = {}): AgentHooks {
  const lock: RunEvalLock = { running: false } // 同一把锁穿给两个钩子
  return {
    transformContext: createTrajectorySlimmer({ keep: options.keep }),
    beforeToolCall: createEvalBeforeToolCall(lock),
    afterToolCall: createScoreThresholdTerminator(options.scoreThreshold, lock),
  }
}
