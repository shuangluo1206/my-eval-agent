#!/bin/bash
# ============================================================
# mini-bench 假评测脚本（测试夹具）
#
# 模拟真 bench 的行为：流式打进度 → 落盘轨迹和分数 → 报目录
# 形状对齐真实 run_eval：产物 = trials/<时间戳>/{trajectory.jsonl,result.json}
# ============================================================

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date +%Y%m%d_%H%M%S)"
TRIAL_DIR="$DIR/workspace/trials/$STAMP"
mkdir -p "$TRIAL_DIR"

echo "[run_eval] 启动被测 agent（mini-bench，仅演示）..."
sleep 1
echo "[run_eval] turn 2/8 done"
sleep 1
echo "[run_eval] turn 5/8 done"
sleep 1
echo "[run_eval] 被测 agent 收工，开始判分..."
sleep 1

# 轨迹：注意 c2 那次 write_file 丢了 path 参数（真实 GLM 坑的复刻）
cat > "$TRIAL_DIR/trajectory.jsonl" << 'EOF'
{"role":"user","content":"请分析 data.csv 并输出结论。"}
{"role":"assistant","content":"我先读数据文件。","tool_calls":[{"id":"c1","name":"read_file","args":{"path":"data.csv"}}]}
{"role":"toolResult","toolCallId":"c1","content":"读取成功：100 行 x 5 列"}
{"role":"assistant","content":"数据没毛病，写分析脚本。","tool_calls":[{"id":"c2","name":"write_file","args":{"path":null,"content":"import pandas\n..."}}]}
{"role":"toolResult","toolCallId":"c2","content":"写入失败：path 参数缺失","isError":true}
{"role":"assistant","content":"参数丢了，补上 path 重试。","tool_calls":[{"id":"c3","name":"write_file","args":{"path":"analysis.py","content":"import pandas\n..."}}]}
{"role":"toolResult","toolCallId":"c3","content":"写入成功：analysis.py"}
{"role":"assistant","content":"结论：周均负载 32,244 MW，环比 +4.2%。"}
EOF

# 分数（模拟一轮真实试标的结果）
cat > "$TRIAL_DIR/result.json" << 'EOF'
{
  "score": 87,
  "total": 99,
  "num_turns": 8,
  "is_error": false,
  "model": "GLM-5.3"
}
EOF

echo "[run_eval] 判分完成：87/99"
echo "TRIAL_DIR=workspace/trials/$STAMP"
