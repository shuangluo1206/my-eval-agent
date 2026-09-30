// ============================================================
// M4 验收 —— 三钩子各验一例（fake provider 走剧本，不烧 token）
//
// 剧本（一条 prompt 触发，三个钩子各出场一次）：
//   ① 瘦身：预塞 10 条长历史 → transformContext 砍成「摘要+最近几条」
//   ② 前置校验：模型拿幻觉路径调 read_trials → beforeToolCall 拦下，
//      模型看到拦截理由后改调 run_eval
//   ③ 达标收尾：run_eval 真跑 mini-bench 得 87 分 ≥ 阈值 80 →
//      afterToolCall 触发 terminate → 循环出口②提前收工
//
// 运行：npm run m4
// ============================================================

import { Agent } from '../src/agent/loop.js'
import { generateId } from '../src/agent/types.js'
import { createEvalHooks } from '../src/agent/eval-hooks.js'
import { runEvalTool } from '../src/tools/eval/run_eval.js'
import { readTrialsTool } from '../src/tools/eval/read_trials.js'
import type { Model, ModelContext, LLMEvent } from '../src/ai/types.js'
import type { AgentMessage } from '../src/agent/types.js'

// ── fake provider：两轮剧本 ──
class FakeModel implements Model {
  id = 'fake-model'
  provider = 'fake'
  private round = 0

  supportsTools(): boolean { return true }

  async *stream(context: ModelContext): AsyncIterable<LLMEvent> {
    this.round++
    if (this.round === 1) {
      // 第 1 轮：拿幻觉路径翻轨迹（会被钩子②拦截）
      yield { type: 'text_delta', delta: '我先翻一下上次的轨迹。' }
      yield {
        type: 'tool_call_start', id: 'call_m4_1', name: 'read_trials',
        args: { trial_dir: '/nonexistent/hallucinated_dir' },
      }
      yield { type: 'done', stopReason: 'tool_use' }
    } else {
      // 第 2 轮：看到拦截理由，乖乖先跑评测
      yield {
        type: 'tool_call_start', id: 'call_m4_2', name: 'run_eval',
        args: { project: 'mini-bench' },
      }
      yield { type: 'done', stopReason: 'tool_use' }
    }
    // 第 3 轮不存在：run_eval 得 87 分 ≥ 80，钩子③ terminate 提前收工
    void context
  }
}

// ── 预塞长历史：1 条旧任务 + 10 条旧轮次（模拟「多轮 read_trials 输出堆满上下文」）──
function seedHistory() {
  const msgs: AgentMessage[] = [{
    id: generateId(), role: 'user' as const,
    content: '历史任务：复盘上一轮 09-24 电网季报包的评测轨迹',
    createdAt: Date.now(),
  }]
  for (let i = 0; i < 5; i++) {
    msgs.push({
      id: generateId(), role: 'assistant' as const, content: `继续复盘第${i}轮`,
      toolCalls: [{ id: `seed_t${i}`, name: 'read_trials', args: { trial_dir: `old_${i}` } }],
      createdAt: Date.now(),
    })
    msgs.push({
      id: generateId(), role: 'toolResult' as const,
      content: `轨迹文件: old_${i}/trajectory.jsonl\n共 120 行，取尾部 20 行\n${'摘要内容…'.repeat(60)}`,
      toolCallId: `seed_t${i}`, createdAt: Date.now(),
    })
  }
  return msgs
}

// ── 组装：真 Agent + 三钩子 + 真工具 ──
const agent = new Agent({
  systemPrompt: '你是评测工程师助手。',
  model: new FakeModel(),
  tools: [runEvalTool, readTrialsTool],
  hooks: createEvalHooks({ keep: 6, scoreThreshold: 80 }),
  onEvent(e) {
    if (e.type === 'tool_execution_start') {
      console.log(`⚙ 调用 ${e.toolName}，参数 ${JSON.stringify(e.args)}`)
    }
    if (e.type === 'tool_execution_end') {
      console.log(`✔ ${e.toolName} 结束${e.isError ? '（拦截/出错）' : ''}`)
    }
  },
})

const seededCount = agent.messages.length + 11 // 预塞 1 条旧任务 + 10 条旧轮次
agent.messages.push(...seedHistory())
console.log('=== M4 验收：三钩子各验一例 ===')
console.log(`（预塞 ${seededCount} 条历史，瘦身阈值 keep=6，达标阈值 80）\n`)

await agent.prompt('帮我跑一轮 mini-bench 评测并复盘。')

// ── 判定 ──
const m = agent.messages

// ① 瘦身：开头出现摘要消息，条数比预塞的少
const slimmed = m[0]?.role === 'user' && m[0].content.includes('已瘦身')

// ② 前置校验：拦截理由进了历史（这条文案只有钩子路径会产生）
const blocked = m.some(
  (x) => x.role === 'toolResult' && x.content.includes('被拦截') && x.content.includes('轨迹目录不存在'),
)

// ③ 达标收尾：run_eval 真跑了、得了分、且循环立刻收工（最后一条是它的结果，
//    没有第 3 轮 assistant 总结——terminate 拦下了多余的一轮）
const runEvalResult = m.find(
  (x) => x.role === 'toolResult' && x.content.includes('得分: 87'),
)
const endedEarly = runEvalResult !== undefined && m[m.length - 1] === runEvalResult

// 旧消息（seed 里的 old_N）被压缩掉了多少条——瘦身的直接证据
const oldKept = m.filter((x) => x.content.includes('old_')).length

console.log(`\n=== 验收（预塞 11 条历史，keep=6；旧长消息仅剩 ${oldKept} 条，其余压成摘要）===`)
console.log(`① transformContext 瘦身   : ${slimmed ? 'OK（旧历史已换成摘要）' : 'FAIL'}`)
console.log(`② beforeToolCall 前置校验  : ${blocked ? 'OK（幻觉路径被拦，理由回给模型）' : 'FAIL'}`)
console.log(`③ afterToolCall 达标收尾  : ${endedEarly ? 'OK（87 分 ≥ 80，跑完即收工）' : 'FAIL'}`)
console.log(`\n首条消息（瘦身摘要）: ${m[0]?.content.slice(0, 80)}…`)

const pass = slimmed && blocked && endedEarly
console.log(`\nM4 结论: ${pass ? 'PASS' : 'FAIL'}`)
process.exit(pass ? 0 : 1)
