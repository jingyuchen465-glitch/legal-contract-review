# 法律 Agent · 合同预审工作台

基于 [xiaodingfeng/contract-review](https://github.com/xiaodingfeng/contract-review) 提交 `c70e32aaad9525b2b60a099ab0251ae64b2d4044` 二次开发，保留上游 MIT 许可与 [原始说明](README.upstream.md)。

面向公司法务的独立 Web 工作台，提供合同接收、台账管理、智能预审、证据定位、追问补充、人工复核、版本化改稿、Word 修订、反馈评测与经验沉淀。前端保留线上侧栏导航和工作台布局，业务接口、权限控制、文档访问和审计记录由本项目维护。**AI 预审完成与法务同意分别记录。**

> **线上同步基线（2026-11-18）**：本仓库按服务器当前活动发布 `20261116-comments-only-1794810033956` 同步，正式站点为 <https://legal.bi.youmeibi.com>。仓库保存源码、配置模板和文档；`.env`、数据库、上传合同、运行时密钥与 Docker 数据卷属于部署环境，不提交到 Git。

2026-11-06 已上线官方 DeepSeek Harness 审查引擎，正式站点：https://legal.bi.youmeibi.com 。真实模型工具调用、历史报告及公网页面验证通过，详见 [Harness 上线记录](docs/Harness上线记录-20261106.md)。Brave 搜索尚未配置，法务质量及外部业务联调边界见记录，工程测试不代替法律质量验收。

## 在当前电脑运行

已准备本机原生 PostgreSQL、Node.js 24、依赖、随机开发配置和管理员账号。工作台地址：**http://localhost:8080**。

初始管理员账号见 [本机凭据文件](.local/initial-admin.txt)。密码不写入本文、不提交 Git。建议每位法务使用独立账号，审计记录保留具体操作者。

服务关闭后，分别在两个终端运行：

```powershell
# 终端 1：原生 PostgreSQL，保持运行
npm run db:local

# 终端 2：构建固定运行时、迁移、初始化并启动 API、Worker、前端
npm run harness:build
npm run db:migrate
npm run setup:local
npm run dev
```

在新电脑先执行 `npm ci`，再按上述步骤操作。本机数据在 `.local/data`，开发数据库在 `%LOCALAPPDATA%/LegalAgentDev`。`.env` 含本机随机密钥，不要覆盖或提交。正式试点通过 `DATA_ROOT` 和 Compose 配置到 `D:/LegalAgentData`，详见部署手册。

`npm run dev` 先检查数据库，并等待已配置的转换服务健康后再启动 API、Worker 和前端；本机转换服务已运行时会复用。转换服务无法启动时会明确报错，避免后台任务批量失败。文件转换使用独立队列，Agent 审查繁忙时后续 Office 文件仍可先完成转换。

## 首次试用

当前审查引擎使用官方 DeepSeek Harness，固定提交 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，由 Worker 通过官方 SDK 启动独立子进程，采用 `sdk-minimal` 和法务业务插件。不是在旧分批审查外再加一层提示词。

1. 配置现有模型网关，在「Agent 运行与官方检索」验证真实工具调用与连续回传。
2. 上传合同即可开始。无需预分析、选择模板、分类确认或勾选审查点。
3. 在同一工作台阅读原文、定位意见证据、补充材料与交易背景。只有缺少影响判断的信息时才提问；等待期间释放 Worker。
4. 法务可继续追问、停止、恢复、在 OnlyOffice 改稿，或整体确认本版结论。追问另存结果版本，已确认结果不覆盖。
5. 保存的法务改稿、采纳、驳回和明确反馈自动提炼为新经验，保留来源、条件与撤销能力，不经过提案发布审批。

新任务不加载旧规则、旧技能和旧经验。原件、版本、历史报告、人工结论及审计继续保留查询和导出；新引擎不会自动回退旧分批审查。

完整架构、配置、验证边界和切换步骤见 [Harness 实施与切换手册](docs/Harness合同审查实施与切换-20261106.md)。Harness 负责执行和上下文管理，推理来自模型；不能据此保证调用更少或法律判断更准确。

## 源码与文档

| 内容 | 入口 |
|---|---|
| 新 Agent 架构、模型配置、备份与切换 | [Harness 实施与切换](docs/Harness合同审查实施与切换-20261106.md) |
| 新 Agent 测试、真实网关结果与未完成验收 | [Harness 工程验证](docs/Harness工程验证-20261106.md) |
| 法务人员日常使用教程 | [法务人员使用教程](docs/法务人员使用教程.md) |
| 界面风格、业务边界与验证 | [界面风格与业务流程说明](docs/界面风格与业务流程说明.md) |
| 文件格式、自动转换及部署 | [文件格式自动转换](docs/文件格式自动转换.md) |
| 开发架构、对象、状态与安全边界 | [开发与架构说明](docs/开发与架构说明.md) |
| Windows 运行、容器、集成配置、备份恢复、迁移 | [部署与操作手册](docs/部署与操作手册.md) |
| 需求逐项追踪、待联调输入、质量目标 | [需求追踪与验收](docs/需求追踪与验收.md) |
| 配置页操作指南 | [配置模块使用说明](docs/配置模块使用说明.md) |
| 录音反馈逐项测试、修复及剩余需求 | [录音反馈测试与修复](docs/录音反馈测试与修复.md) |
| Agent／跨会话交接、线上版本与后续验收 | [录音反馈修复与上线交接](docs/AGENT交接-录音反馈修复与上线.md) |
| 本次工程验证结果与限制 | [工程验证记录](docs/工程验证记录.md) |
| 一份合同一个综合技能、文件加载与升级 | [综合技能使用与验收](docs/一合同一综合技能-20261105.md) |
| HTTP 接口与请求参数 | [OpenAPI 3.1](docs/openapi.json) |
| 上游与依赖许可清单 | [依赖许可与上游](docs/依赖许可与上游.md) |
| 现有业务工作台、账号、钉钉、预审与复核 | `backend/pilot/`、`frontend/src/pilot/` |
| 视觉样式覆盖（不改变页面布局） | `frontend/src/pilot/appearance.css` |
| 官方 Harness 会话、业务工具和新记忆 | `backend/pilot/agent/`、`runtime/legal-harness/` |
| 独立 CPU OCR 服务 | `ocr/` |
| 配置示例与部署编排 | `.env.example`、`docker-compose.yml`、`Dockerfile` |

当前入口继续挂载本项目的 `/api` 业务接口、会话登录、权限校验、文档访问控制和 OnlyOffice 服务。未切换为上游独立审查应用；上游页面与服务源码保留供对照，默认入口不启用其浏览器指纹登录或匿名文件目录。

新入口使用 `backend/pilot/agent/` 与 `frontend/src/pilot/AgentReview.vue`。旧规则、技能、经验发布及独立预分析写接口返回 HTTP 410；数据库与只读兼容代码用于历史查询，不供新 Agent 加载。历史设计文档反映旧版本，不应继续用于新任务配置。

## 验证与运维

```powershell
npm test                    # 解析、网关、引用校验及报告映射
npm run test:integration:isolated # 自动启动临时 PostgreSQL，测试后关闭
npm run test:agent          # Agent 专项隔离测试
npm run harness:build       # 固定源码运行时及依赖许可清单
npm run harness:cutover     # 只读预检；-- --apply 才执行退役
npm run build
npm audit --omit=dev
npm run openapi
npm run backup
npm run restore:drill       # 独立空库恢复演练
```

备份工具可通过 `scripts/postgres-tools.ps1` 从 PostgreSQL 官方 EDB 发行包准备。恢复只能指向独立空库与独立空目录。日常备份默认保留 30 天；迁移和升级前保管数据库、不可变原件与原 `TOKEN_SECRET`。

Docker / WSL2 当前尚未就绪，Compose 已提供但未完成实际容器启动验证。上线还需要两类各至少 20 份法务标注合同、风险与证据标注、指定模型配置、钉钉应用权限与真实审批联调。分类 95%、高风险召回 95% 等为验收目标，尚无真实样本评测证明。

反馈处理请见 [反馈与评测使用说明](docs/反馈与评测使用说明.md)。
