# 法律 Agent · 合同预审工作台

基于 [xiaodingfeng/contract-review](https://github.com/xiaodingfeng/contract-review) 提交 `c70e32aaad9525b2b60a099ab0251ae64b2d4044` 二次开发，保留上游 MIT 许可与 [原始说明](README.upstream.md)。

面向公司法务的独立 Web 工作台，支持合同接收、结构化解析、分类及专项标签、版本化规则、异步预审、证据定位、人工复核、修改重审、最终结论与人工回传归档。**AI 预审完成与法务同意分别记录。**

当前交付是可运行的开发实现。真实模型、钉钉、PaddleOCR、OnlyOffice、Milvus 与法务质量验收仍需配置及联调，不能把工程测试结果当作已完成业务上线验收。

## 在当前电脑运行

已准备本机原生 PostgreSQL、Node.js 24、依赖、随机开发配置和管理员账号。工作台地址：**http://localhost:8080**。

初始管理员账号见 [本机凭据文件](.local/initial-admin.txt)。密码不写入本文、不提交 Git。所有账号统一为系统管理员，可提交、复核、维护规则和发布。建议每位法务使用独立账号，审计记录保留具体操作者。

服务关闭后，分别在两个终端运行：

```powershell
# 终端 1：原生 PostgreSQL，保持运行
npm run db:local

# 终端 2：迁移、初始化并启动 API、Worker、前端
npm run db:migrate
npm run setup:local
npm run dev
```

在新电脑先执行 `npm ci`，再按上述步骤操作。本机数据在 `.local/data`，开发数据库在 `%LOCALAPPDATA%/LegalAgentDev`。`.env` 含本机随机密钥，不要覆盖或提交。正式试点通过 `DATA_ROOT` 和 Compose 配置到 `D:/LegalAgentData`，详见部署手册。

## 首次试用

1. 为各位法务建立独立管理员账号，并配置指定模型服务。
2. 法务依据公司标准审核规则并发布；初始化的通用、采购、海外仓及软件类规则只是示例草稿。
3. 业务上传 PDF / DOCX，填写我方主体、立场和交易目的。每份文件上限 50MB；旧 DOC 需转换。
4. 法务确认分类与立场，逐条处理风险及不确定项。修改后上传新版本，或使用已联通的 OnlyOffice。
5. 全部问题处理后，由法务确认同意、附条件同意或不同意。下载终稿和报告，人工回传钉钉并记录归档。

未配置模型、正式规则或 OCR 时，任务会明确进入待处理状态，不会生成虚假的完整审查结果。四大类十三类型均可归档分类，任一类型发布适用专项规则后即可正式预审。

采购、海外仓及软件类可在合同详情点击「示例规则试审」，使用固定版本的内置参考检查项体验完整流程。软件类含 11 项专项及 4 项通用检查，覆盖开发、许可、订阅及维护服务。试审不发布规则，页面及报告明确标记为示例，不能直接确认最终结论；正式使用仍需法务发布公司标准后重新预审。详见[软件合同审查使用说明](docs/软件合同审查使用说明.md)。

## 源码与文档

| 内容 | 入口 |
|---|---|
| 开发架构、对象、状态与安全边界 | [开发与架构说明](docs/开发与架构说明.md) |
| Windows 运行、容器、集成配置、备份恢复、迁移 | [部署与操作手册](docs/部署与操作手册.md) |
| 需求逐项追踪、待联调输入、质量目标 | [需求追踪与验收](docs/需求追踪与验收.md) |
| 配置页操作指南 | [配置模块使用说明](docs/配置模块使用说明.md) |
| 中文表单配置、规则审核与发布 | [规则配置使用说明](docs/规则配置使用说明.md) |
| 本次工程验证结果与限制 | [工程验证记录](docs/工程验证记录.md) |
| HTTP 接口，51 个操作 | [OpenAPI 3.1](docs/openapi.json) |
| 上游与依赖许可清单 | [依赖许可与上游](docs/依赖许可与上游.md) |
| 后端业务与迁移 | `backend/pilot/` |
| 六组前端工作台页面 | `frontend/src/pilot/` |
| 独立 CPU OCR 服务 | `ocr/` |
| 配置示例与部署编排 | `.env.example`、`docker-compose.yml`、`Dockerfile` |

上游旧代码保留供二开对照；当前入口不会挂载指纹自动登录、匿名合同静态目录或自动公开法律导入。

## 验证与运维

```powershell
npm test                    # 解析、网关、引用校验及报告映射
npm run test:integration    # 独立 PostgreSQL 测试库；需要 pg_dump/pg_restore
npm run build
npm audit --omit=dev
npm run openapi
npm run backup
npm run restore:drill       # 独立空库恢复演练
```

备份工具可通过 `scripts/postgres-tools.ps1` 从 PostgreSQL 官方 EDB 发行包准备。恢复只能指向独立空库与独立空目录。日常备份默认保留 30 天；迁移和升级前保管数据库、不可变原件与原 `TOKEN_SECRET`。

Docker / WSL2 当前尚未就绪，Compose 已提供但未完成实际容器启动验证。上线还需要两类各至少 20 份法务标注合同、正式规则及模板、指定模型配置、钉钉应用权限与真实审批联调。分类 95%、高风险召回 95% 等为验收目标，尚无真实样本评测证明。

反馈处理请见 [反馈与评测使用说明](docs/反馈与评测使用说明.md)。
