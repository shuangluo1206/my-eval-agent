// ============================================================
// M5 验收 —— 多模型路由（fake 双模型走剧本，不烧 token）
//
// 剧本（一条 prompt 走完两套路由策略）：
//   轮1: 主力开局报 502 → 路由当轮无缝切备用（Agent 无感知），备用写报告
//   轮2: 主力回归但 write_file 丢 path（bench 实测老毛病）→ 连败计数
//        → 永久降级到备用
//   轮3: 备用接手写摘要
//   轮4: 备用给最终结论收工
//
// 验证三点：
//   ① 主力的报错从没漏到 Agent（历史里没有 [模型错误] 字样）
//   ② 降级真的发生了（routingLog 有记录，轮2 的 write_file 真失败了）
//   ③ 任务照样完成（两份文件都写出来了）
//
// 运行：npm run m5
// ============================================================

import { existsSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { Agent } from '../src/agent/loop.js'
import type { AgentTool } from '../src/agent/types.js'
import { ModelRouter } from '../src/ai/router.js'
import type { Model, ModelContext, LLMEvent } from '../src/ai/types.js'

const REPORT = '/tmp/m5-report.md'
const SUMMARY = '/tmp/m5-summary.md'
for (const f of [REPORT, SUMMARY]) {
  if (existsSync(f)) rmSync(f)
}

// ── fake 主力：轮1 掉线，轮2 丢 path（复刻 GLM bench 实测脾气）──
class FakePrimary implements Model {
  id = 'GLM-5.3 (fake)'
  provider = 'fake'
  private round = 0

  supportsTools(): boolean { return true }

  async *stream(_context: ModelContext): AsyncIterable<LLMEvent> {
    this.round++
    if (this.round === 1) {
      yield { type: 'error', message: '网关 502 Bad Gateway（模拟主力掉线）' }
      return
    }
    // 轮2：参数碎片里压根没有 path 字段
    yield { type: 'text_delta', delta: '我来写摘要。' }
    yield { type: 'tool_call_start', id: 'c_p2', name: 'write_file', args: {} }
    yield { type: 'tool_call_delta', id: '', delta: '{"content":"' }
    yield { type: 'tool_call_delta', id: '', delta: '周均负载 32,244 MW"}' }
    yield { type: 'done', stopReason: 'tool_use' }
  }
}

// ── fake 备用：正常干活（轮1 报告 / 轮2 摘要 / 轮3 结论）──
class FakeFallback implements Model {
  id = 'DeepSeek-V4-Pro (fake)'
  provider = 'fake'
  private round = 0

  supportsTools(): boolean { return true }

  async *stream(_context: ModelContext): AsyncIterable<LLMEvent> {
    this.round++
    if (this.round === 1) {
      yield { type: 'text_delta', delta: '主力掉线我顶上，先写报告。' }
      yield {
        type: 'tool_call_start', id: 'c_f1', name: 'write_file',
        args: { path: REPORT, content: '# 评测报告\n结论：87/99，含一次 write_file 失败后自愈。' },
      }
      yield { type: 'done', stopReason: 'tool_use' }
      return
    }
    if (this.round === 2) {
      yield { type: 'text_delta', delta: '降级到我这边了，写摘要。' }
      yield {
        type: 'tool_call_start', id: 'c_f2', name: 'write_file',
        args: { path: SUMMARY, content: '一句话：主力丢 path 被降级，任务无损完成。' },
      }
      yield { type: 'done', stopReason: 'tool_use' }
      return
    }
    yield { type: 'text_delta', delta: '两份文件都写好了，任务完成。' }
    yield { type: 'done', stopReason: 'end_turn' }
  }
}

// ── 真工具：write_file（path 缺失时 isError，模拟真实文件写入）──
const writeFileTool: AgentTool = {
  name: 'write_file',
  description: '把文本写进指定文件',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件路径' },
      content: { type: 'string', description: '写入内容' },
    },
    required: ['path', 'content'],
  },
  async execute(_id, params) {
    const path = params.path
    if (typeof path !== 'string' || path.length === 0) {
      return { content: [{ type: 'text', text: '写入失败：path 参数缺失' }], isError: true }
    }
    writeFileSync(path, String(params.content ?? ''))
    return { content: [{ type: 'text', text: `写入成功: ${path}` }] }
  },
}

// ── 组装：Agent 只认 Model 接口，不知道背后是路由器 ──
const router = new ModelRouter(new FakePrimary(), new FakeFallback())

const agent = new Agent({
  systemPrompt: '你是评测工程师助手，把结论写进文件。',
  model: router,
  tools: [writeFileTool],
  onEvent(e) {
    if (e.type === 'tool_execution_start') {
      console.log(`⚙ [${router.lastServedBy.id}] 调用 ${e.toolName}，参数 ${JSON.stringify(e.args).slice(0, 80)}`)
    }
    if (e.type === 'tool_execution_end') {
      console.log(`✔ ${e.toolName} 结束${e.isError ? '（失败）' : ''}`)
    }
  },
})

console.log('=== M5 验收：多模型路由（GLM 主力 + DeepSeek 备用）===\n')
await agent.prompt('把本轮评测结论写进报告文件，再写一份一句话摘要。')

// ── 判定 ──
const m = agent.messages

// ① 当轮无缝切换：主力报错从没漏到 Agent 的历史里
const errorLeaked = m.some((x) => x.content.includes('[模型错误'))
const failoverLogged = router.routingLog.some((l) => l.includes('当轮无缝切'))

// ② 质量降级：丢 path 真失败过 + 降级有记录
const pathLossFailed = m.some(
  (x) => x.role === 'toolResult' && x.isError && x.content.includes('path 参数缺失'),
)
const degradeLogged = router.routingLog.some((l) => l.includes('永久降级'))

// ③ 任务完成：两份文件都写出来了
const filesWritten = existsSync(REPORT) && existsSync(SUMMARY)
const finalSaid = (m.at(-1)?.content ?? '').includes('任务完成')

console.log('\n=== 路由决策日志 ===')
for (const line of router.routingLog) console.log(`  · ${line}`)

console.log(`\n=== 验收 ===`)
console.log(`① 当轮无缝切换  : ${!errorLeaked && failoverLogged ? 'OK（主力的报错 Agent 全程无感知）' : 'FAIL'}`)
console.log(`② 质量降级      : ${pathLossFailed && degradeLogged ? 'OK（write_file 丢 path 触发永久降级）' : 'FAIL'}`)
console.log(`③ 任务无损完成  : ${filesWritten && finalSaid ? 'OK（report.md + summary.md 都落盘）' : 'FAIL'}`)

const pass = !errorLeaked && failoverLogged && pathLossFailed && degradeLogged && filesWritten && finalSaid
console.log(`\n摘要文件内容: ${readFileSync(SUMMARY, 'utf-8')}`)
console.log(`\nM5 结论: ${pass ? 'PASS' : 'FAIL'}`)
process.exit(pass ? 0 : 1)
