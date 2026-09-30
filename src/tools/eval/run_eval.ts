// ============================================================
// run_eval 工具 —— 跑一轮评测（M3 主角之一）
//
// 干的事：spawn 一个评测脚本当子进程，等它跑完，解析产物。
// 四个关键设计（全是踩坑换来的，见文件尾注释）：
//   1. signal 一路传给子进程 —— 用户 Ctrl+C 时子进程也得死
//   2. onUpdate 流式回传日志 —— 跑几分钟的任务不能憋到最后
//   3. isError 看 result.json 的 is_error，不看退出码
//      （被测 agent 跑 0 分 ≠ 评测本身失败，退出码非 0 不代表崩）
//   4. 只增不删 —— 轨迹目录留给 read_trials 复盘，绝不清理
// ============================================================

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentTool } from '../../agent/types.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../')

// 项目注册表：项目名 → 评测脚本路径（以后接真 bench 就在这加一行）
const PROJECTS: Record<string, string> = {
  'mini-bench': resolve(REPO_ROOT, 'fixtures/mini-bench/run.sh'),
}

interface TrialResult {
  score?: number
  total?: number
  num_turns?: number
  is_error?: boolean
  [key: string]: unknown
}

export const runEvalTool: AgentTool = {
  name: 'run_eval',
  description:
    '跑一轮评测。返回分数、轮数和本轮轨迹目录（trial_dir），轨迹目录可传给 read_trials 工具复盘。',
  parameters: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: '要评测的项目名，如 mini-bench',
      },
      timeout_ms: {
        type: 'number',
        description: '超时（毫秒），默认 600000（10 分钟）',
      },
    },
    required: ['project'],
  },

  async execute(_toolCallId, params, signal, onUpdate) {
    const project = String(params.project ?? '')
    const timeoutMs = Number(params.timeout_ms ?? 600_000)

    const script = PROJECTS[project]
    if (!script) {
      return {
        content: [{
          type: 'text',
          text: `未知项目: ${project}。可用项目: ${Object.keys(PROJECTS).join(', ')}`,
        }],
        isError: true,
      }
    }
    if (!existsSync(script)) {
      return {
        content: [{ type: 'text', text: `评测脚本不存在: ${script}` }],
        isError: true,
      }
    }

    // ── 起子进程 ──
    // 防父会话环境变量传染（ANTHROPIC_MODEL 之类会改变子 agent 行为）
    const env = { ...process.env }
    delete env.ANTHROPIC_MODEL

    const child = spawn('bash', [script], {
      cwd: dirname(script),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = '' // 全量日志（结束时截尾返回，防止撑爆上下文）
    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString()
      output += text
      onUpdate?.(text) // 流式回传：边跑边报
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)

    // 超时：杀子进程，返回 isError
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)

    // 取消：signal 一路传到子进程（关键！不然 Ctrl+C 后子进程变孤儿）
    const onAbort = () => child.kill('SIGKILL')
    signal.addEventListener('abort', onAbort, { once: true })

    const exitCode = await new Promise<number>((resolveExit) => {
      child.on('close', (code) => resolveExit(code ?? -1))
    })

    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)

    // ── 从日志里挖轨迹目录（脚本最后一行会打 TRIAL_DIR=...）──
    // 统一解析成绝对路径：脚本报的是相对它自己目录的路径，
    // 直接透传的话 read_trials 会拿进程 cwd 去解析 → 找不到文件（M3 联调实测踩坑）
    const trialDirMatch = output.match(/TRIAL_DIR=(\S+)/)
    const trialDir = trialDirMatch?.[1]
      ? resolve(dirname(script), trialDirMatch[1])
      : undefined

    // ── 解析 result.json：分数的真正出处 ──
    let trial: TrialResult | null = null
    if (trialDir) {
      const resultPath = resolve(trialDir, 'result.json')
      if (existsSync(resultPath)) {
        try {
          trial = JSON.parse(readFileSync(resultPath, 'utf-8')) as TrialResult
        } catch {
          // result.json 坏了不算崩，带着原始日志返回让模型自己看
        }
      }
    }

    // ── isError 判定：只认「评测本身失败」，不认「被测 agent 分低」──
    const evalCrashed =
      exitCode !== 0 && trial === null && !trialDir // 非零退出且啥产物都没有
      || trial?.is_error === true

    const lines = [
      `评测完成（退出码 ${exitCode}）`,
      trial
        ? `得分: ${trial.score ?? '?'}/${trial.total ?? '?'}，轮数: ${trial.num_turns ?? '?'}`
        : '（未找到可解析的 result.json）',
      trialDir ? `轨迹目录: ${trialDir}` : '（未找到轨迹目录）',
      '--- 日志尾部 ---',
      ...output.trimEnd().split('\n').slice(-8), // 只给尾部 8 行，防撑爆
    ].join('\n')

    return { content: [{ type: 'text', text: lines }], isError: evalCrashed || undefined }
  },
}
