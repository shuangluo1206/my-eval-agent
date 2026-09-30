// ============================================================
// run_eval 工具 —— 跑一轮评测（M3 上线，M6 接入真实 bench）
//
// 干的事：spawn 一个评测脚本当子进程，等它跑完，解析产物。
// 支持两类项目：
//   · mini-bench（内置夹具）：bash 脚本，产物 result.json + TRIAL_DIR= 行
//   · 真实 bench（projects.local.json 注册）：python 脚本，产物在
//     trials/<时间戳>/ 下的 outcome_grade.json + trajectory.jsonl
//     （本地路径不进仓库，gitignored）
//
// 关键设计（全是踩坑换来的）：
//   1. signal 一路传给子进程 —— 用户 Ctrl+C 时子进程也得死
//   2. onUpdate 流式回传日志 —— 跑几分钟的任务不能憋到最后
//   3. isError 看判分产物，不看退出码
//      （被测 agent 跑 0 分 ≠ 评测本身失败，退出码非 0 不代表崩）
//   4. 只增不删 —— 轨迹目录留给 read_trials 复盘，绝不清理
//   5. 分数统一输出「得分: X/100」格式 —— 上游钩子（达标收尾）
//      的正则不用关心是哪种 bench
// ============================================================

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentTool } from '../../agent/types.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../')

// ── 项目注册表 ────────────────────────────────────────────

interface ProjectEntry {
  /** 评测脚本绝对路径（.py 用 python3 拉，其他用 bash） */
  script: string
  /** 传给脚本的额外参数（支持 ${ENV_VAR} 占位符，从 .env 注入的值替换） */
  args?: string[]
  /** 该项目的超时（毫秒），默认 600000 */
  timeoutMs?: number
}

/** 内置项目（仓库自带，公开可见） */
const BUILTIN_PROJECTS: Record<string, ProjectEntry> = {
  'mini-bench': { script: resolve(REPO_ROOT, 'fixtures/mini-bench/run.sh') },
}

/** 读 projects.local.json（gitignored）：本地真 bench 注册处 */
function loadLocalProjects(): Record<string, ProjectEntry> {
  const path = resolve(REPO_ROOT, 'projects.local.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, ProjectEntry>
  } catch (e) {
    throw new Error(`projects.local.json 解析失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** ${VAR} 占位符替换成环境变量值（.env 的值由 loadEnv 注入 process.env） */
function substituteEnvVars(args: string[]): string[] {
  return args.map((a) => a.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g,
    (_, varName) => process.env[varName] ?? ''))
}

function getProjects(): Record<string, ProjectEntry> {
  return { ...BUILTIN_PROJECTS, ...loadLocalProjects() }
}

// ── 产物解析 ──────────────────────────────────────────────

interface TrialSummary {
  score?: number
  total?: number
  numTurns?: number
  passed?: boolean
  isEvalError?: boolean
}

/** 真 bench：扫 trials/ 找最新目录（目录名带时间戳前缀，字典序即时间序） */
function findLatestTrialDir(scriptDir: string): string | undefined {
  const trialsDir = resolve(scriptDir, 'trials')
  if (!existsSync(trialsDir)) return undefined
  const dirs = readdirSync(trialsDir)
    .filter((d) => statSync(resolve(trialsDir, d)).isDirectory())
    .sort()
  return dirs.length > 0 ? resolve(trialsDir, dirs[dirs.length - 1]) : undefined
}

/** 真 bench 产物：workspace/outcome_grade.json（判分器落的真分） */
function parseOutcomeGrade(trialDir: string): TrialSummary | null {
  const p = resolve(trialDir, 'workspace', 'outcome_grade.json')
  if (!existsSync(p)) return null
  try {
    const g = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
    // 轮数 = 轨迹里 step_start 的出现次数（真轨迹一行一个事件）
    let numTurns: number | undefined
    const traj = resolve(trialDir, 'trajectory.jsonl')
    if (existsSync(traj)) {
      numTurns = readFileSync(traj, 'utf-8').split('\n')
        .filter((l) => l.includes('"type": "step_start"')).length
    }
    return {
      score: typeof g.outcome_score_pct === 'number' ? g.outcome_score_pct : undefined,
      total: 100,
      numTurns,
      passed: g.passed === true,
      isEvalError: g.is_error === true,
    }
  } catch {
    return null
  }
}

/** mini-bench 产物：result.json */
function parseResultJson(trialDir: string): TrialSummary | null {
  const p = resolve(trialDir, 'result.json')
  if (!existsSync(p)) return null
  try {
    const r = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
    return {
      score: typeof r.score === 'number' ? r.score : undefined,
      total: typeof r.total === 'number' ? r.total : undefined,
      numTurns: typeof r.num_turns === 'number' ? r.num_turns : undefined,
      isEvalError: r.is_error === true,
    }
  } catch {
    return null
  }
}

// ── 工具本体 ──────────────────────────────────────────────

export const runEvalTool: AgentTool = {
  name: 'run_eval',
  description:
    '跑一轮评测。返回分数、轮数和本轮轨迹目录（trial_dir），轨迹目录可传给 read_trials 工具复盘。',
  parameters: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: '要评测的项目名，如 mini-bench 或 projects.local.json 里注册的项目',
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

    const projects = getProjects()
    const entry = projects[project]
    if (!entry) {
      return {
        content: [{
          type: 'text',
          text: `未知项目: ${project}。可用项目: ${Object.keys(projects).join(', ')}`,
        }],
        isError: true,
      }
    }
    if (!existsSync(entry.script)) {
      return {
        content: [{ type: 'text', text: `评测脚本不存在: ${entry.script}` }],
        isError: true,
      }
    }

    const scriptDir = dirname(entry.script)
    const timeoutMs = Number(params.timeout_ms ?? entry.timeoutMs ?? 600_000)
    const extraArgs = entry.args ? substituteEnvVars(entry.args) : []

    // ── 起子进程：.py 用 python3，.sh 用 bash ──
    const isPython = entry.script.endsWith('.py')
    const command = isPython ? 'python3' : 'bash'

    // 防父会话环境变量传染（ANTHROPIC_MODEL 之类会改变子 agent 行为）
    const env = { ...process.env }
    delete env.ANTHROPIC_MODEL

    const child = spawn(command, [entry.script, ...extraArgs], {
      cwd: scriptDir,
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

    // ── 定位轨迹目录：脚本自己报（mini-bench）或扫 trials/ 找最新（真 bench）──
    const trialDirMatch = output.match(/TRIAL_DIR=(\S+)/)
    let trialDir: string | undefined
    if (trialDirMatch) {
      // 统一解析成绝对路径：脚本报的是相对它自己目录的路径，
      // 直接透传的话 read_trials 会拿进程 cwd 去解析 → 找不到文件（M3 联调实测踩坑）
      trialDir = resolve(scriptDir, trialDirMatch[1])
    } else {
      trialDir = findLatestTrialDir(scriptDir)
    }

    // ── 解析分数：真 bench 用 outcome_grade，夹具用 result.json ──
    let trial: TrialSummary | null = trialDir ? parseOutcomeGrade(trialDir) : null
    if (!trial && trialDir) trial = parseResultJson(trialDir)

    // ── isError 判定：只认「评测本身失败」，不认「被测 agent 分低」──
    const evalCrashed =
      (exitCode !== 0 && trial === null && !trialDir) // 非零退出且啥产物都没有
      || trial?.isEvalError === true

    const lines = [
      `评测完成（退出码 ${exitCode}）`,
      trial
        ? `得分: ${trial.score ?? '?'}/${trial.total ?? '?'}，轮数: ${trial.numTurns ?? '?'}${trial.passed !== undefined ? `，${trial.passed ? '通过' : '未通过'}` : ''}`
        : '（未找到可解析的判分产物）',
      trialDir ? `轨迹目录: ${trialDir}` : '（未找到轨迹目录）',
      '--- 日志尾部 ---',
      ...output.trimEnd().split('\n').slice(-8), // 只给尾部 8 行，防撑爆
    ].join('\n')

    return { content: [{ type: 'text', text: lines }], isError: evalCrashed || undefined }
  },
}
