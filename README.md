# my-eval-agent

评测工程师垂直 Agent —— **评估 Agent 的 Agent**。

手写 Agent 循环（非框架）+ OpenAI 兼容多模型接入 + 评测专用工具层 + 垂直化三钩子 + 多模型路由降级。

## 为什么造它

跑一轮 bench 试标，被测 agent 要转几十个 turn，评测工程师得全程盯轨迹：工具调用对不对、卡在哪一步、判分器为什么扣分——一轮半小时起步。

盯到第三轮就会想到：**读轨迹、查判分点这种活，本身就是个能被 Agent 干的事。**

于是有了这个项目：一个只懂评测的垂直 Agent。通用 Agent 帮人写代码，它帮评测工程师审 Agent。

## 架构

```
cli / demo 脚本
      │
      ▼
┌─────────────────┐     ┌──────────────────────┐
│   agent/loop     │────▶│  tools (ToolRegistry) │
│  while 主循环     │     │  run_eval  read_trials │
└────┬────────────┘     └──────────────────────┘
     │ Model 接口              ▲ 前置校验 / 达标收尾
     ▼                         │ （三钩子从外面插进循环）
┌──────────────────────────────┴──┐
│   ai 层：ModelRouter → Provider   │
│   SSE 拆包 / OpenAI 兼容 / 重试    │
└──────────────────────────────────┘
```

- **依赖方向只许向下**：loop 只认 `Model` 接口和 `ToolRegistry.getTool()`，不知道任何具体模型和工具
- **换模型 = 换注册条目，加工具 = 换注册条目**，循环一行不动

## 里程碑

- **M1 AI 层**：类型契约（ToolCall / LLMMessage / LLMEvent）+ SSE 拆包 + OpenAI 兼容层 + 注册表 + 真调网关冒烟（流式 + 工具调用链路）
- **M2 循环**：Agent while 主循环 + fake provider 演示（工具参数从字节流碎片拼装）
- **M3 真活**：run_eval / read_trials 真工具 + 真模型联调
- **M4 钩子**：轨迹瘦身 / 前置校验 / 达标收尾（验收各一例，M2/M3 回归全 PASS）
- **M5 路由**：多模型路由降级
- **M6 真 bench**：接入真实数据分析 bench 任务包——外层 Agent 自主拉起被测 agent（9 轮 12 次工具调用）→ 57 个判分点真判分（47.4/100）→ 读真轨迹复盘定位失分原因，全程 2.2 分钟、人工介入 0

## 真实 bench 接入（M6）

真 bench 走 `projects.local.json` 注册（gitignored，本地路径不入仓库），换同族项目零代码、一行注册：

```json
{
  "taobao-ctr": {
    "script": "/abs/path/to/数据分析_bench/002_taobao_ctr_analysis/run_eval.py",
    "args": ["--api-base", "${EVAL_AGENT_BASE_URL}", "--api-key", "${EVAL_AGENT_API_KEY}", "--model", "GLM-5.3"],
    "timeoutMs": 1800000
  }
}
```

产物解析做多级格式探测（outcome_grade.json → result.json），适配代码跟着「格式家族」走、不跟项目数走——数据分析_bench 001~010 与 KA 系任务包共用同一套产物约定，全部一行接入。轨迹摘要同时支持 mini-bench 夹具格式与 ducc 风格真轨迹（tool_use / reasoning / text 事件）。

## 差异化一：垂直化三钩子

循环是通用的，一个字不懂「评测」；垂直智能全在钩子里从外面插进循环：

| 钩子 | 用法 | 防的坑 |
|---|---|---|
| `transformContext` 轨迹瘦身 | 历史超限时整轮砍掉换摘要 | 孤儿 toolResult 触发网关 422 |
| `beforeToolCall` 前置校验 | trial_dir 不存在 → 拦截；run_eval 防并发 | 模型拿幻觉路径连环重试 |
| `afterToolCall` 达标收尾 | 分数 ≥ 阈值 → 提前 terminate | 模型看完高分再总结一轮的 token |

## 差异化二：多模型路由（M5）

主力 + 备用双模型，路由器实现 `Model` 接口——Agent 根本不知道背后站着两个模型：

```
· 主力 GLM-5.3 开局报错（网关 502）→ 当轮无缝切 DeepSeek-V4-Pro（下轮主力继续）
· 主力 write_file 丢 path（bench 实测老毛病），连败 1
· 主力连败 1 轮（阈值 1） → 永久降级到 DeepSeek-V4-Pro
```

三种策略：**开局报错当轮无缝切换**（错误事件不外传）、**质量降级**（write_file 丢 path 连败计数触发永久降级）、**流中途报错只计数下轮生效**（事件已放行没法收回）。每次路由决策记一行 `routingLog`，演示可复现。

## 快速开始

```bash
cp .env.example .env   # 填入网关地址与 API Key（不入仓库）
npm install
npm run m1             # M1 冒烟：真调网关一次（含工具调用）
```

## 分层

- `src/ai/` 模型接入：类型契约 / SSE 拆包 / OpenAI 兼容层 / 注册表 / Provider / 多模型路由
- `src/agent/` Agent 循环 + 三钩子（loop.ts / eval-hooks.ts）
- `src/tools/` 评测工具：run_eval / read_trials
- `fixtures/` mini-bench 测试夹具（5 秒假评测，产物形状对齐真 bench）

## 验收

```bash
npm run typecheck && npm run m2 && npm run m4 && npm run m5   # 不烧 token
npm run m3                                                    # 真模型联调（烧 token）
npm run m6                                                    # 真实 bench 全链路（烧 token，需 projects.local.json）
```

## 致谢

分层思想与类型契约参考了 [my-easy-pi](https://github.com/KNeegcyao/my-easy-pi)（基于 Pi 设计哲学的开源教学项目，10 章渐进式教程），代码从零实现。
