# 法务 Harness 插件

与官方 `deepseek-ai/deepseek-harness@fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` 的 SDK、`sdk-minimal`、内核及插件一起运行，不是独立 ReAct 实现。

`plugin.mjs` 注册受限业务工具和数据库 Skill provider；`compaction.mjs` 使用官方压缩引擎与法务摘要模板；`probe.mjs` 用于模型工具兼容验证。脚本执行能力不注册。

宿主编排、官方源配置、取消和真实请求预算见 `backend/pilot/agent/runtime.js`。通过 `npm run harness:build` 构建；构建固定源码、保留 `UPSTREAM-MIT-LICENSE`，并生成安装依赖的许可清单。详细部署与切换见 `docs/Harness合同审查实施与切换-20261106.md`。
