# my-eval-agent

评测工程师垂直 Agent —— 评估 Agent 的 Agent。
手写 Agent 循环（非框架）+ OneAPI 网关接入 + 评测专用工具层。

## 快速开始

cp .env.example .env   # 填入网关地址与 API Key
npm install
npm run m1              # M1 冒烟：真调网关一次（含工具调用）

## 分层

- src/ai/        模型接入：类型契约 / SSE 拆包 / OpenAI 兼容层 / 注册表 / Provider
- src/agent/     Agent 循环（M2）
- src/tools/     评测工具（M3）：run_eval / read_trials

详见设计稿。
