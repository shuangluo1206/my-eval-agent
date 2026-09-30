// ============================================================
// M2 演示 —— fake provider 跑通完整循环（不烧 token）
//
// 剧本（验证 M2 验收标准「问→调工具→回结果→收尾」）：
//   第一轮：模型说"我查一下" + 要调 get_time（参数碎片分两半到）
//   工具执行：真的跑 get_time（new Date）
//   第二轮：模型看到时间，给出最终回答，不再要工具 → 出口①收工
//
// fake provider 同时验证了「参数碎片拼装」：碎片 '{"tz' + '":"UTC"}'
// 单独哪个都不是合法 JSON，必须在 done 时整体 parse。
// ============================================================

import { Agent } from '../src/agent/loop.js'
import type { AgentTool } from '../src/agent/types.js'
import type { Model, ModelContext, LLMEvent } from '../src/ai/types.js'

// ── fake provider：按剧本回放事件流 ──
class FakeModel implements Model {
  id = 'fake-model'
  provider = 'fake'
  private round = 0

  supportsTools(): boolean { return true }

  async *stream(context: ModelContext): AsyncIterable<LLMEvent> {
    this.round++
    if (this.round === 1) {
      // 第一轮：说话 + 碎片式要工具
      yield { type: 'text_delta', delta: '我来查一下时间。' }
      yield { type: 'tool_call_start', id: 'call_001', name: 'get_time', args: {} }
      yield { type: 'tool_call_delta', id: '', delta: '{"tz' }   // 碎片1：不是合法 JSON
      yield { type: 'tool_call_delta', id: '', delta: '":"UTC"}' } // 碎片2
      yield { type: 'done', stopReason: 'tool_use' }
    } else {
      // 第二轮：从历史里找到工具结果，复述出来，收工
      const last = context.messages[context.messages.length - 1]
      yield { type: 'text_delta', delta: `查到了：${last.content}（第 ${this.round} 轮收工）` }
      yield { type: 'done', stopReason: 'end_turn' }
    }
  }
}

// ── 真工具：get_time ──
const getTimeTool: AgentTool = {
  name: 'get_time',
  description: '获取当前时间',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(_id, params) {
    const tz = (params.tz as string) || 'local'
    const now = new Date().toLocaleString('zh-CN')
    return { content: [{ type: 'text', text: `现在时间(${tz})：${now}` }] }
  },
}

// ── 跑循环 ──
const agent = new Agent({
  systemPrompt: '你是演示助手。',
  model: new FakeModel(),
  tools: [getTimeTool],
  onEvent(e) {
    if (e.type === 'tool_execution_start') {
      console.log(`  ⚙ 执行工具 ${e.toolName}，参数 ${JSON.stringify(e.args)}`)
    }
  },
})

console.log('=== M2 演示：fake provider 跑通完整循环 ===\n')
await agent.prompt('现在几点了？')

console.log('\n=== 消息历史（循环跑完后应该有 4 条）===')
for (const m of agent.messages) {
  const head = `[${m.role}]`
  const body = m.content.length > 60 ? m.content.slice(0, 60) + '…' : m.content
  const calls = m.toolCalls ? `（要调工具: ${m.toolCalls.map(t => `${t.name}${JSON.stringify(t.args)}`).join(', ')}）` : ''
  console.log(`${head.padEnd(12)}${body}${calls}`)
}

// 判定
const ok =
  agent.messages.length === 4 &&
  agent.messages[1].toolCalls?.[0]?.args &&
  (agent.messages[1].toolCalls[0].args as { tz?: string }).tz === 'UTC' && // 碎片拼装成功才算对
  agent.messages[2].role === 'toolResult'
console.log(`\nM2 判定：${ok ? 'PASS（碎片拼装/工具执行/结果回传/收尾 全通）' : 'FAIL'}`)
process.exit(ok ? 0 : 1)
