// ============================================================
// M1 冒烟测试 —— 真调网关一次，验证两件事：
//   ① 流式返回是 choices[0].delta 形态（convertOpenAIEvent 能吃）
//   ② 带 tools 时模型会吐 tool_calls（工具调用链路通）
//
// 运行：npm run m1   （需要 .env 填好 BASE_URL 和 API_KEY）
// 可选参数：npm run m1 -- DeepSeek-V4-Pro（默认 GLM-5.3）
// ============================================================

import { loadEnv, getConfig } from '../src/config.js'
import { OneApiProvider } from '../src/ai/providers/ernie.js'
import type { LLMEvent } from '../src/ai/types.js'

loadEnv()
const { baseUrl, apiKey } = getConfig()

const modelId = process.argv[2] || 'GLM-5.3'
console.log(`=== M1 冒烟：${modelId} ===\n`)

const provider = OneApiProvider.create({ apiKey, baseUrl })
const model = provider.createModel(modelId)
if (!model) {
  console.error(`模型不在菜单里：${modelId}（可选：${provider.listModels().map(m => m.id).join(' / ')}）`)
  process.exit(1)
}

const context = {
  systemPrompt: '你是测试助手。',
  messages: [{ role: 'user' as const, content: '现在几点了？用工具查一下。' }],
  tools: [
    {
      name: 'get_time',
      description: '获取当前时间',
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  ],
}

let sawText = false
let sawToolStart = false
let sawToolDelta = false
let sawDone = false

for await (const ev of model.stream(context)) {
  describe(ev).forEach((line) => console.log(line))
  if (ev.type === 'text_delta') sawText = true
  if (ev.type === 'tool_call_start') sawToolStart = true
  if (ev.type === 'tool_call_delta') sawToolDelta = true
  if (ev.type === 'done') sawDone = true
}

console.log('\n=== 判定 ===')
console.log(`文本流 text_delta      : ${sawText ? 'OK' : 'MISSING'}`)
console.log(`工具开始 tool_call_start: ${sawToolStart ? 'OK' : 'MISSING（模型可能没决定调工具，重跑一次）'}`)
console.log(`工具碎片 tool_call_delta: ${sawToolDelta ? 'OK' : '（无碎片也正常：一次性给全参数）'}`)
console.log(`结束事件 done           : ${sawDone ? 'OK' : 'MISSING'}`)
console.log(`\nM1 结论：${sawDone && (sawText || sawToolStart) ? 'PASS' : 'FAIL'}（tool_call_start 通过才算工具链路通）`)

function describe(ev: LLMEvent): string[] {
  switch (ev.type) {
    case 'text_delta':
      return [`text_delta       "${ev.delta.slice(0, 60)}"`]
    case 'tool_call_start':
      return [`tool_call_start  id=${ev.id} name=${ev.name} args=${JSON.stringify(ev.args).slice(0, 80)}`]
    case 'tool_call_delta':
      return [`tool_call_delta  "${ev.delta.slice(0, 60)}"`]
    case 'error':
      return [`error            ${ev.message}`]
    case 'done':
      return [`done             stopReason=${ev.stopReason}`]
  }
}
