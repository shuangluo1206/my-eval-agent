// ============================================================
// ToolRegistry —— 工具注册表（Map<名字, AgentTool>）
//
// 与 ModelRegistry 同一个套路：换血 = 换注册条目。
// 注意：同名注册静默覆盖（Map.set 的行为），工具名要集中定义成常量防手滑。
// ============================================================

import type { AgentTool } from '../agent/types.js'

export class ToolRegistry {
  private tools = new Map<string, AgentTool>()

  registerTool(tool: AgentTool): void {
    this.tools.set(tool.name, tool)
  }

  unregisterTool(name: string): void {
    this.tools.delete(name)
  }

  getTool(name: string): AgentTool | undefined {
    return this.tools.get(name)
  }

  listTools(): AgentTool[] {
    return Array.from(this.tools.values())
  }
}
