# DeepSeek Harness 技能机制与复用评估

核验日期：2026-11-05。上游：DeepSeek 官方 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，默认分支 `master`；本次源码固定在 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。本次仅阅读源码和文档，未安装运行上游代码，未将其接入审查服务。

## 结论

可以依法复用其 MIT 许可源码。其最有参考价值的设计是“技能来源提供方 → 统一目录 → 按需加载正文 → 关联资源按需读取”。它的技能系统负责保存后的发现、选择和加载；在本次核查的技能三个核心包、preset 及技能文档中，没有发现“每次任务完成后自动复盘、提炼、审核并发布新技能”的完整内置学习流水线。不能把它解释为模型权重训练，也不能把该范围的未发现推论为整个生态不存在学习插件。

证据：[官方技能子系统文档](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/skills.zh.md)、[注册表源码](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill/skill/src/index.ts)、[本地提供方源码](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill/skill-filesystem/src/index.ts)、[工具消费方源码](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill/tool-skill/src/index.ts)。

## 怎样沉淀

本地技能以 `<name>/SKILL.md` 目录包或者 `<name>.md` 平铺文件保存；不是递归扫描任意深度的 `**/SKILL.md`。YAML frontmatter 要有 `name` 和 `description`，正文为 Markdown 操作指令。目录可附带 `references/`、`scripts/`、模板及资产；这些资源不随目录一次性灌入模型。其文件格式解析入口是 `parseSkillFile()` 和 `parseFrontmatter()`。

```text
.agents/skills/contract-payment-review/
  SKILL.md
  references/payment-examples.md
```

```yaml
---
name: contract-payment-review
description: 审查采购合同付款条件、验收前置条件与付款期限时使用。
---
```

正文可写适用条件、操作步骤、例外和验证方法。上述合同示例是本次为说明格式编写，不是 DeepSeek 随包法务技能。技能由人或获得写入任务的 agent 编辑保存；保存后本地提供方监视目录变化，使目录缓存失效并在后续步骤更新可见技能。`ctx.skills.register()` 另支持运行时注册；注册表本身不替业务完成持久化、提炼或审核。

`agent-experience` 这个随包技能讲工具描述、发现与上下文效率，它不是“自动总结历史经验”的执行引擎。证据：[技能正文](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/preset/agent-preset/skills/agent-experience/SKILL.md)、[preset 对随包技能的说明](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/preset/agent-preset/README.zh.md)。

## 怎样加载给 agent

1. **发现来源。** 本地提供方默认依次扫描项目 `.dsh/skills`、项目 `.agents/skills`、自定义目录、用户 `.dsh/skills`、用户 `.agents/skills` 和配置的 bundled 目录。同层内 rank 较小者覆盖同名技能；scope 层还决定 agent/preset 可见范围，最近 scope 层优先。
2. **提供摘要目录。** `tool-skill` 在 `agent/pre-step` 获取当前 agent、cwd 和 scope 对应的技能快照，向会话追加 `<system-reminder>` 内的 `<available_skills>`；模型目录仅含名称与描述，描述默认最多 500 字符，不包含技能正文或绝对路径。目录变化后追加替换目录，压缩隐藏旧目录时重新建立。
3. **触发选择。** `skill` 工具描述要求 agent 在任务命名或明显匹配目录技能时先调用。通常由模型根据描述选择，不是提供方内置关键词匹配器或自动向量检索。人也可在真实用户消息首行用 `/<name>` 显式调用允许用户调用的技能。
4. **加载正文。** agent 调用 `skill({ name })`；工具校验名称和模型调用权限，使用 `ctx.skills.get(name, {cwd, signal, scope})` 加载获胜提供方的完整定义，作为工具结果返回。注册表不缓存完整定义，本地提供方每次重新读取正文。
5. **读取附属资源。** 工具结果包含 `<skill_content>`、`<skill_resources>` 和 `<skill_instructions>`；资源基址可为目录、URL 或提供方管理的 opaque 描述。根据正文明确引用，再调用文件/网络等工具读取参考材料或使用脚本；加载正文不等于自动执行脚本。

`disable-model-invocation` 与 `user-invocable` 是两个独立 frontmatter 控制项，省略时均允许相应入口；工具加载前后均检查模型调用策略。目录发现异常时可返回不完整快照且不缓存，以便下一次重试。

证据定位：[注册与 list/get](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill/skill/src/index.ts#L390)、[本地 list/get](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill/skill-filesystem/src/index.ts#L185)、[解析文件](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill/skill-filesystem/src/index.ts#L811)、[skill 工具](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill/tool-skill/src/index.ts#L84)、[显式用户调用](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill/tool-skill/src/index.ts#L167)、[目录注入](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill/tool-skill/src/index.ts#L217)。

## 哪些源码可借用，为什么不是复制后即用

| 包 | 职责 | 已核对的依赖边界 |
|---|---|---|
| `@deepseek-ai/dsh-skill` | 提供方注册、scope/rank 目录合并、list/get、技能形状与渲染 | Cordis、dsh-llm、dsh-scope、dsh-util-values、schemastery |
| `@deepseek-ai/dsh-skill-filesystem` | 本地目录扫描、frontmatter 解析、watcher 与失效 | Cordis、dsh-fs、dsh-home-paths、dsh-skill、Chokidar、YAML、schemastery |
| `@deepseek-ai/dsh-tool-skill` | pre-step 摘要注入、技能工具、显式用户调用 | Cordis、dsh-agent、dsh-llm、dsh-skill、dsh-tools、dsh-working-directory、schemastery；源码也使用 session 类型/工具 |

这些包是 Cordis 插件体系的一部分，不是三个完全独立的通用 Node.js 函数。源码是 TypeScript/ESM，包含 `workspace:*`/`workspace:~` 依赖；整仓要求 Node.js >=24.9 和 pnpm 11。因此应在“接入其运行时及插件体系”和“提取其解析、目录、加载设计后适配现有服务”之间作明确选择。现有数据库也可仿照 `SkillProvider.list/get` 接口供给目录与正文，不必先把所有业务技能迁成磁盘文件。

依赖证据：[skill/package.json](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill/skill/package.json)、[skill-filesystem/package.json](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill/skill-filesystem/package.json)、[tool-skill/package.json](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill/tool-skill/package.json)、[根 package.json](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/package.json)。

## 许可证与版本

根 LICENSE 为 MIT，版权 `Copyright (c) 2026 DeepSeek`。允许使用、复制、修改、合并、分发、再许可和销售；复制代码或实质部分时须保留版权及许可声明。第三方依赖仍分别遵循其许可证，应保留适用的第三方声明。MIT 不要求我们的业务代码整体开源。

官方 README 明示 developer preview，可能存在兼容性破坏变更。若引入源码，应固定 commit、记录改动，并保留上游来源和 LICENSE；不能把固定版本行为写成永久稳定 API。

证据：[LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/LICENSE)、[第三方声明](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/THIRD_PARTY_NOTICES.md)、[README 预览状态](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/README.md)。

## 与当前合同预审项目的对比

以下是对当前工作区代码的核验，不代表本次检查了生产部署状态。当前实现已有业务经验沉淀闭环：法务最终确认后，由 `learning.js:71` 的 `enqueueLearning()` 根据自动整理设置创建任务；`processLearning()` 在 `learning.js:156` 读取确认稿、直接上一版及人工处理记录，调用 `model.js:223` 的 `distill()` 提炼候选，并校验来源、去重和归并。`learning.js:233` 的 `adoptProposal()` 将采纳提案写成技能或规则草稿；`skills.js` 的状态接口继续控制提交、发布和停用。持久化存储是 PostgreSQL 的 `la_skill_versions`，Markdown 是导出视图。

新预审由 `workflow.js:29` 冻结已发布候选；分类后 `workflow.js:109` 调用 `skills.js:22` 的 `matchSkills()` 匹配通用/合同类型技能。启用 `LEARNING_CATALOG_ENABLED` 时，还按业务标签和依赖规则内容签名过滤，并记录被排除条目的原因。不开启该开关时沿用包级规则版本依赖。不能把功能开关后的行为无条件视为所有环境都已启用。

`model.js:181` 的 `review()` 把 `skillInput()` 生成的正文 JSON 随每个审查请求发送。开启目录功能时 `knowledge-catalog.js:43` 按最多 20 条、约 24000 字符分组；所有匹配技能仍参与，不是摘要后自主按需加载。该路径的基础请求数为正文分片数 × 规则批次数 × 技能批次数，另外可能有重试。`model.js:112` 的 `chat()` 当前使用要求 JSON 结果的 Chat Completions，没有提供 `tools` 或处理 `tool_calls` 的循环；因此仅加入一个 `skill` 函数不会自动获得 DSH 的调用行为。

| 方面 | DeepSeek Harness 本次核查实现 | 我们当前代码 |
|---|---|---|
| 持久化 | 本地技能文件；也允许自定义提供方 | 数据库版本、来源与发布状态 |
| 经验提炼 | 技能子系统未包含业务提炼审核闭环 | 确认稿/改稿/人工处理 → 候选 → 采纳 → 审核发布 |
| 路由 | 摘要目录供模型选择或用户显式调用 | 合同类型；开关开启时增加标签和规则签名 |
| 正文装载 | `skill({name})` 按需读取 | 匹配后的全部技能正文分批注入 |
| 内容变化 | 后续 get 读取当前正文 | 预审冻结内容及版本，支持复现 |

## 建议的复用边界（尚未实施）

1. 保留现有数据库、提炼、法务发布和任务快照；适配 DSH 的 `list/get` 提供方接口及摘要/正文分离设计。若借用其具体解析或渲染代码，单独存放并附 MIT 声明，固定本次核验 commit。
2. 第一阶段可用两阶段调用：先对已通过类型、标签和规则依赖筛选的技能提供短摘要，返回技能 ID；服务端检查所选 ID 必须属于本次已冻结候选，再把对应正文交给原审查流程。它是我们建议的实现，不是 DSH 上游原有执行方式。
3. 所有必审规则继续逐项检查；应标记必须加载的方法，避免完全依赖模型选择造成漏用。验证选用准确性、法务意见质量、规则覆盖、调用成本及实际读取记录，再决定是否切换默认路径。
4. 如需 agent 在审查过程中反复调用 `skill`、读取引用或运行获准工具，再实现工具 schema、`tool_calls` 循环和调用限制，或评估接入完整 DSH 运行时。当前流程不需要为了技能格式而整体迁移到 Cordis。
5. 加载只能读取本次冻结的技能版本；不要直接照搬上游“后续 get 读最新正文”的行为到法务预审，否则同一任务的可复现性会改变。

本次产物仅为研究笔记；未改动业务源码、依赖、数据库或部署配置，也未执行上游代码。
