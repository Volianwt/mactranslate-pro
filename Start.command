#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "======================================"
echo "    启动 MacTranslate Pro..."
echo "    请不要关闭这个终端窗口！"
echo "    如果要退出，请按 Control + C"
echo "======================================"
sleep 1
echo "正在构建生产版本..."
npm run build
echo "正在启动生产服务..."
(sleep 2 && open "http://localhost:3000") &
npm run start
