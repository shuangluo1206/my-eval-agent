// ============================================================
// read_trials 工具 —— 读 agent 轨迹做摘要（M3 主角之二）
//
// 干的事：逐行读 trajectory.jsonl，每行压成一行摘要。
// 两个防爆炸设计：
//   1. tail 截尾 —— 轨迹动辄几百轮，全给会把上下文撑爆
//   2. 摘要不改写 —— 角色/工具名/内容片段照抄，只截短
//      （复盘要的是「它当时真说了什么」，不能转述失真）
// ============================================================

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentTool } from '../../agent/types.js'

interface TrajectoryEntry {
  role?: string
  type?: string
  content?: unknown
  tool_calls?: { name?: string; args?: unknown }[]
  toolCallId?: string
  isError?: boolean
  [key: string]: unknown
}

/** 一行轨迹压成一句话（保真截短，不转述） */
function summarize(entry: TrajectoryEntry, lineNo: number): string {
  const parts: string[] = []

  const who = entry.role ?? entry.type ?? '?'

  if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
    for (const tc of entry.tool_calls) {
      const argsStr = JSON.stringify(tc.args ?? {})
      const argsShort = argsStr.length > 80 ? argsStr.slice(0, 80) + '…' : argsStr
      parts.push(`${who}→工具 ${tc.name ?? '?'}${argsShort}`)
    }
  } else {
    const text = typeof entry.content === 'string'
      ? entry.content
      : JSON.stringify(entry.content ?? '')
    const short = text.length > 80 ? text.slice(0, 80) + '…' : text
    parts.push(`${who}: ${short}`)
  }

  const flag = entry.isError ? ' ⚠️ERROR' : ''
  return `${String(lineNo).padStart(3)} | ${parts.join(' ；')}${flag}`
}

export const readTrialsTool: AgentTool = {
  name: 'read_trials',
  description:
    '读一轮评测的 agent 轨迹（trajectory.jsonl），返回逐行摘要。可用 keyword 过滤、tail 只看尾部 N 行。',
  parameters: {
    type: 'object',
    properties: {
      trial_dir: {
        type: 'string',
        description: '轨迹目录（run_eval 返回的 trial_dir）或 trajectory.jsonl 的路径',
      },
      tail: {
        type: 'number',
        description: '只取最后 N 行，默认 20',
      },
      keyword: {
        type: 'string',
        description: '只保留含该关键词的行（如 write_file）',
      },
    },
    required: ['trial_dir'],
  },

  async execute(_toolCallId, params) {
    const dirOrPath = String(params.trial_dir ?? '')
    const tail = Number(params.tail ?? 20)
    const keyword = params.keyword ? String(params.keyword) : undefined

    // trial_dir 可能是目录（找里面的 trajectory.jsonl），也可能直接是文件路径
    let filePath = resolve(dirOrPath)
    if (!filePath.endsWith('.jsonl')) {
      filePath = resolve(dirOrPath, 'trajectory.jsonl')
    }

    if (!existsSync(filePath)) {
      return {
        content: [{ type: 'text', text: `轨迹文件不存在: ${filePath}` }],
        isError: true,
      }
    }

    const raw = readFileSync(filePath, 'utf-8')
    const allLines = raw.split('\n').filter((l) => l.trim() !== '')

    let picked = allLines
    if (keyword) {
      picked = picked.filter((l) => l.includes(keyword))
    }
    if (picked.length > tail) {
      picked = picked.slice(-tail)
    }

    if (picked.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `轨迹共 ${allLines.length} 行，过滤后 0 行（keyword=${keyword ?? '无'}）`,
        }],
      }
    }

    const summaries: string[] = []
    let parseFail = 0
    for (const line of picked) {
      try {
        summaries.push(summarize(JSON.parse(line) as TrajectoryEntry, allLines.indexOf(line) + 1))
      } catch {
        parseFail++
        summaries.push('?? | （非 JSON 行，截短）' + line.slice(0, 60))
      }
    }

    const head = [
      `轨迹文件: ${filePath}`,
      `共 ${allLines.length} 行${keyword ? `，keyword="${keyword}" 过滤后 ${picked.length} 行` : `，取尾部 ${picked.length} 行`}`,
      parseFail > 0 ? `（${parseFail} 行解析失败）` : '',
      '---',
    ].filter(Boolean).join('\n')

    return { content: [{ type: 'text', text: head + '\n' + summaries.join('\n') }] }
  },
}
