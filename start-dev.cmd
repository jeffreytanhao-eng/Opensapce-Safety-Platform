@echo off
rem ============================================================
rem 后端一键启动（开发环境）
rem 前置：MySQL 已由 docker compose -f docker-compose.dev.yml up -d 启动
rem 说明：server.jsc 是【Windows 版 Node 22.12.0】编译的 V8 字节码，
rem       只能用 tools\node-v22.12.0-win-x64 里的配套运行时加载。
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0server"
"..\tools\node-v22.12.0-win-x64\node.exe" index.cjs
pause
