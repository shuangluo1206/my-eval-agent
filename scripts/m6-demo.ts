// ============================================================
// M6 联调 —— 真模型 + 真工具 + 真 bench + 三钩子（全副武装）
//
// 和 m3（mini-bench 夹具联调）的区别：被测评测是真的——
//   run_eval 拉起 数据分析_bench/002_taobao_ctr_analysis 的 run_eval.py，
//   里面 minimal_agent.py 真的拿 GLM-5.3 当被测 agent 干活十几分钟，
//   判分器真算分，轨迹是真 agent 行为（几十上百行）。
//
// 链路两层套娃：
//   外层：eval-agent（GLM-5.3 当脑子 + 三钩子）
//     └─ run_eval 工具 → 子进程 run_eval.py
//          └─ 子进程 minimal_agent.py（被测 agent，也是 GLM-5.3）
//
// 运行：npm run m6   （需要 .env 配好网关 + projects.local.json 注册项目）
// 真跑要 10~20 分钟、烧真 token（两层模型都在调网关）
// ============================================================

import { loadEnv, getConfig } from '../src/config.js'
import { OneApiProvider } from '../src/ai/providers/ernie.js'
import { Agent } from '../src/agent/loop.js'
import { createEvalHooks } from '../src/agent/eval-hooks.js'
import { runEvalTool } from '../src/tools/eval/run_eval.js'
import { readTrialsTool } from '../src/tools/eval/read_trials.js'

loadEnv()
const { baseUrl, apiKey } = getConfig()

const modelId = process.argv[2] || 'GLM-5.3'
const project = process.argv[3] || 'taobao-ctr'
console.log(`=== M6 真实 bench 联调：${modelId} 跑 ${project}（10~20 分钟）===\n`)

const provider = OneApiProvider.create({ apiKey, baseUrl })
const model = provider.createModel(modelId)
if (!model) {
  console.error(`模型不在菜单里：${modelId}`)
  process.exit(1)
}

// 流式打字效果：message_update 是全量快照，只打新增的尾巴
let printedLen = 0

const agent = new Agent({
  systemPrompt: [
    '你是评测工程师助手，负责跑评测、复盘轨迹。',
    '规则：',
    '1. 跑评测用 run_eval 工具，不要自己编造分数。',
    '2. run_eval 跑真 bench 可能要十几分钟，耐心等它完成，不要中途放弃。',
    '3. 复盘轨迹用 read_trials 工具，传入 run_eval 返回的轨迹目录。',
    '4. 轨迹文件只读不删。',
    '5. 所有任务完成后用中文给出简洁结论。',
  ].join('\n'),
  model,
  tools: [runEvalTool, readTrialsTool],
  hooks: createEvalHooks({ scoreThreshold: 80 }), // 真分数 <80 不会提前收尾
  onEvent(e) {
    switch (e.type) {
      case 'tool_execution_start':
        console.log(`\n⚙ 调用 ${e.toolName}，参数 ${JSON.stringify(e.args)}`)
        break
      case 'tool_execution_update':
        // 子进程日志流式打（去掉换行紧凑显示）
        process.stdout.write(`  ∣ ${e.chunk.replace(/\n/g, '')}`)
        break
      case 'tool_execution_end':
        console.log(`\n✔ ${e.toolName} 完成${e.isError ? '（isError）' : ''}`)
        break
      case 'message_update': {
        if (e.content.length > printedLen) {
          process.stdout.write(e.content.slice(printedLen))
          printedLen = e.content.length
        }
        break
      }
    }
  },
})

// 总闸：40 分钟没跑完就掐（真 bench 有不确定性，闸要够宽）
const killer = setTimeout(() => {
  console.error('\n⏰ 超时，中止')
  agent.abort()
}, 2_400_000)

const startedAt = Date.now()
await agent.prompt(
  `帮我跑一轮 ${project} 评测，报告得分和轮数；然后读这轮轨迹的尾部（tail 用 30），` +
  '总结被测 agent 主要用了哪些工具、有没有失败操作，最后一句话总结。',
)
clearTimeout(killer)
printedLen = 0

const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1)

// ── 判定：不靠肉眼，看消息历史里真发生过什么 ──
const m = agent.messages
const calledTools = m
  .flatMap((x) => (x.role === 'assistant' && x.toolCalls ? x.toolCalls : []))
  .map((tc) => tc.name)
console.log(`\n\n=== 消息历史（${m.length} 条，工具链: ${calledTools.join(' → ') || '无'}，总耗时 ${minutes} 分钟）===`)

const sawRunEval = calledTools.includes('run_eval')
const sawReadTrials = calledTools.includes('read_trials')

// 真分数：run_eval 的结果里抠出数字（不是夹具写死的 87）
const runEvalResult = m.find(
  (x) => x.role === 'toolResult' && x.content.includes('得分:'),
)
const scoreMatch = runEvalResult?.content.match(/得分:\s*(\d+(?:\.\d+)?)\/(\d+)/)
const gotRealScore = scoreMatch !== null && scoreMatch !== undefined

// read_trials 至少成功一次
const readTrialIds = m
  .flatMap((x) => (x.role === 'assistant' && x.toolCalls ? x.toolCalls : []))
  .filter((tc) => tc.name === 'read_trials')
  .map((tc) => tc.id)
const readTrialsSucceeded = m.some(
  (x) => x.role === 'toolResult' && x.toolCallId && readTrialIds.includes(x.toolCallId) && !x.isError,
)

const hasFinalAnswer = m.at(-1)?.role === 'assistant'
  && (m.at(-1)?.content.length ?? 0) > 10

console.log(`run_eval 真调过      : ${sawRunEval ? 'OK' : 'MISSING'}`)
console.log(`真分数解析到         : ${gotRealScore && scoreMatch ? `OK（${scoreMatch[1]}/${scoreMatch[2]}）` : 'MISSING'}`)
console.log(`read_trials 真读到过 : ${readTrialsSucceeded ? 'OK' : 'MISSING'}`)
console.log(`最终中文结论         : ${hasFinalAnswer ? 'OK' : 'MISSING'}`)
const pass = sawRunEval && gotRealScore && readTrialsSucceeded && hasFinalAnswer
console.log(`\nM6 结论: ${pass ? 'PASS' : 'FAIL'}（真实 bench 全链路）`)

process.exit(pass ? 0 : 1)
