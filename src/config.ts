// ============================================================
// 配置加载 —— 极简 .env 读取（不引 dotenv 依赖）
//
// 网关地址和 key 都走 .env（.gitignore 已排除），仓库可公开。
// ============================================================

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

export interface AppConfig {
  baseUrl: string
  apiKey: string
}

/** 读项目根目录的 .env 并注入 process.env（已存在的环境变量优先） */
export function loadEnv(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return
  const text = readFileSync(path, 'utf-8')
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!(key in process.env)) process.env[key] = value
  }
}

export function getConfig(): AppConfig {
  return {
    baseUrl: process.env.EVAL_AGENT_BASE_URL || '',
    apiKey: process.env.EVAL_AGENT_API_KEY || '',
  }
}
