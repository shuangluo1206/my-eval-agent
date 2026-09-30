# my-eval-agent

评测工程师垂直 Agent —— 评估 Agent 的 Agent。
手写 Agent 循环（非框架）+ OneAPI 网关接入 + 评测专用工具层 + 垂直化三钩子。

## 快速开始

cp .env.example .env   # 填入网关地址与 API Key
npm install
npm run m1              # M1 冒烟：真调网关一次（含工具调用）

## 里程碑

- M1 冒烟：AI 层真调网关（流式 + 工具调用链路）
- M2 循环：Agent while 主循环 + fake provider 演示（参数碎片拼装）
- M3 真活：run_eval / read_trials 真工具 + 真模型联调
- M4 钩子：轨迹瘦身 / 前置校验 / 达标收尾（验收各一例）

## 分层

- src/ai/        模型接入：类型契约 / SSE 拆包 / OpenAI 兼容层 / 注册表 / Provider
- src/agent/     Agent 循环 + 三钩子（loop.ts / eval-hooks.ts）
- src/tools/     评测工具：run_eval / read_trials
- fixtures/      mini-bench 测试夹具（5 秒假评测，产物形状对齐真 bench）

## 验收

npm run typecheck && npm run m2 && npm run m4   # 不烧 token
npm run m3                                      # 真模型联调（烧 token）

详见设计稿。
