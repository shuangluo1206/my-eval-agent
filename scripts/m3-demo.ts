// ============================================================
// M3 联调 —— 真模型 + 真工具，机器人第一次干真活
//
// 任务（一条 prompt 触发完整多轮循环）：
//   "跑一轮 mini-bench 评测，报分数；再翻轨迹查有没有失败操作"
// 预期行为：
//   轮1: GLM 决定调 run_eval（跑 ~4 秒，流式回传日志）
//   轮2: 看到分数和轨迹目录，决定调 read_trials
//   轮3: 看到轨迹摘要，发现 write_file 丢 path 的报错，给结论收工
//
// 运行：npm run m3   （需要 .env 填好 BASE_URL 和 API_KEY，烧真 token）
// ============================================================

import { loadEnv, getConfig } from '../src/config.js'
import { OneApiProvider } from '../src/ai/providers/ernie.js'
import { Agent } from '../src/agent/loop.js'
import { runEvalTool } from '../src/tools/eval/run_eval.js'
import { readTrialsTool } from '../src/tools/eval/read_trials.js'

loadEnv()
const { baseUrl, apiKey } = getConfig()

const modelId = process.argv[2] || 'GLM-5.3'
console.log(`=== M3 联调：${modelId} 真跑 mini-bench ===\n`)

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
    '2. 复盘轨迹用 read_trials 工具，传入 run_eval 返回的轨迹目录。',
    '3. 轨迹文件只读不删。',
    '4. 所有任务完成后用中文给出简洁结论。',
  ].join('\n'),
  model,
  tools: [runEvalTool, readTrialsTool],
  onEvent(e) {
    switch (e.type) {
      case 'tool_execution_start':
        console.log(`\n⚙ 调用 ${e.toolName}，参数 ${JSON.stringify(e.args)}`)
        break
      case 'tool_execution_update':
        // 子进程日志，去掉换行紧凑打
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

// 总闸：5 分钟没跑完就掐
const killer = setTimeout(() => {
  console.error('\n⏰ 超时，中止')
  agent.abort()
}, 300_000)

await agent.prompt('帮我跑一轮 mini-bench 评测，报告得分和轮数；然后读这轮的轨迹，检查被测 agent 有没有失败的操作，最后一句话总结。')

clearTimeout(killer)
printedLen = 0

// ── 判定：不靠肉眼，看消息历史里真发生过什么 ──
const calledTools = agent.messages
  .flatMap((m) => (m.role === 'assistant' && m.toolCalls ? m.toolCalls : []))
  .map((tc) => tc.name)
console.log(`\n\n=== 消息历史（${agent.messages.length} 条，调过的工具: ${calledTools.join(' → ') || '无'}）===`)

const sawRunEval = calledTools.includes('run_eval')
const sawReadTrials = calledTools.includes('read_trials')
// read_trials 至少成功一次（防「调了但全失败」的机械 PASS）
const readTrialIds = agent.messages
  .flatMap((m) => (m.role === 'assistant' && m.toolCalls ? m.toolCalls : []))
  .filter((tc) => tc.name === 'read_trials')
  .map((tc) => tc.id)
const readTrialsSucceeded = agent.messages.some(
  (m) => m.role === 'toolResult' && m.toolCallId && readTrialIds.includes(m.toolCallId) && !m.isError,
)
const hasFinalAnswer = agent.messages.at(-1)?.role === 'assistant'
  && (agent.messages.at(-1)?.content.length ?? 0) > 10

console.log(`run_eval 真调过      : ${sawRunEval ? 'OK' : 'MISSING'}`)
console.log(`read_trials 真调过   : ${sawReadTrials ? 'OK' : 'MISSING'}${sawReadTrials && !readTrialsSucceeded ? '（但全部失败，不算数）' : ''}`)
console.log(`轨迹真读到过         : ${readTrialsSucceeded ? 'OK' : 'MISSING'}`)
console.log(`最终中文结论         : ${hasFinalAnswer ? 'OK' : 'MISSING'}`)
console.log(`\nM3 结论: ${sawRunEval && readTrialsSucceeded && hasFinalAnswer ? 'PASS' : 'FAIL'}`)

process.exit(sawRunEval && readTrialsSucceeded && hasFinalAnswer ? 0 : 1)
