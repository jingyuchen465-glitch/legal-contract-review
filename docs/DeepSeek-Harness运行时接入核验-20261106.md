# DeepSeek Harness 运行时接入核验

核验日期：2026-11-06。固定官方源码提交：`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，包版本 `0.2.2-rc.1`。本文件区分源码事实、应用建议和已经执行的验证；不将架构复用等同于质量或调用次数改善。

## 结论

本项目可以直接复用官方 `@deepseek-ai/dsh-sdk-client` 启动 `sdk-minimal` 子进程，保留上游 Agent loop、工具执行、JSONL 会话和压缩流程，再通过 Cordis patch 加载法律业务插件及现有 OpenAI Chat Completions 网关。业务应用负责审查版本、合同读取、引用核验、新经验数据库和交互界面。无需复制或另写一个声称兼容 Harness 的 ReAct 循环。

这里的 ReAct 指模型观察工具结果后继续决定下一步；它不要求向界面展示模型内部思维过程。Skill 是被检索、按需加载并加入上下文的操作知识，调用工具和持续循环才使其能够执行工作。一次 `run()` 可触发多次模型调用，也可能触发压缩和重试；不能以 SDK 调用次数充当模型请求次数。

来源：[SDK API](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sdk/client/src/api.ts)、[Agent loop](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop)、[Skill](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill)。

## 1. 固定源码和构建边界

源码下载在 `.local/harness-upstream/`，来自官方 GitHub 固定提交 tarball。Windows tar 对部分符号链接条目报错，实际 TypeScript 源码、包清单和配置已提取；不能把这次解包描述为所有条目均成功。未修改上游受版本控制源码。

上游要求 Node `>=24.9.0` 和 pnpm `11.28.5`；本次 Node 为 `24.21.0`。通过 `npm exec --yes --package=pnpm@11.28.5 -- pnpm ...` 使用精确包管理器版本。即使仅筛选 SDK、sdk-minimal、pi-ai、skill、ask-user，SDK 对 CLI 的依赖仍将安装闭包扩大至 360/394 工作区、1152 个外部依赖。不要假定 minimal profile 自动意味着安装包极小。

官方完整构建入口为 `pnpm run build:artifacts`，涉及原生扩展、Typert、Host/Client/Desktop/Web。`build:lib:host` 同样不是只构建 SDK。源码 SDK 支持官方源码启动回退：缺少 CLI `lib/bin.js` 时自动用 `tsx/esm` 加载 `apps/cli/src/bin.ts`，并注入源码兼容 patch 与 `TSX_TSCONFIG_PATH`。

生产部署应使用经过 CI 构建的固定版本 runtime 与依赖闭包，或者明确选择源码运行并带齐源码和 tsx。不能只复制 SDK 的 `lib/index.js`，它会继续解析并启动同版本 `@deepseek-ai/dsh`。自定义 `dshBin` 会使用普通 Node 直接执行指定文件，因此不能把它随意指向需要 tsx 的 `src/bin.ts`。

源码：[根清单](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/package.json)、[构建任务图](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/scripts/build.ts)、[SDK 启动器](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sdk/client/src/launch.ts)、[CLI 清单](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/cli/package.json)。

## 2. SDK 的实际调用方式

```js
const harness = new DeepSeekHarness({
  profile: 'sdk-minimal',
  patches: [absoluteLegalPatch],
  dshHome: persistentTaskDataPath,
  cwd: taskWorkspace,
  processCwd: taskWorkspace,
  provider: 'legal-gateway',
  model: frozenModelId,
  maxTokens: 4096,
  env: completeChildEnvironment,
  onUserQuestion: async (request, { signal }) => waitForBusinessAnswer(request, signal),
});
const result = await harness.run(prompt, { sessionId, onNotification });
// 后续输入复用同一活动会话。
await harness.session(sessionId).run(followup, { onNotification });
// 另一个进程重新加载已有持久化会话时，必须显式恢复。
await harness.resumeSession(sessionId);
await harness.close();
```

`session(id)` 只取得惰性句柄，不等于从磁盘恢复；正确 API 是 `resumeSession`。一个审查会话只安排一个活动输入。建议每个活动审查独占一个 runtime 子进程，数据库保存业务版本与 sessionId，持久化 dshHome，恢复时重新核对冻结模型与知识版本。`maxTokens` 限制单次模型输出，不能用来限制整个任务消耗。

源码：[公开选项](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sdk/client/src/types.ts)、[高层 API](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sdk/client/src/api.ts)。

## 3. Cordis patch 必须按真实语义编写

```yaml
- id: compaction-basic
  disabled: true
- insert:
    - id: legal-compaction
      name: ./legal-compaction.js
      config:
        headroomTokens: 4096
        maxTokens: 2048
        thresholdRatio: 0.8
        retainRatio: 0.16
```

Patch 没有通用 `remove/delete` 操作。已有行上的 `name` 是匹配断言，不能用它更换插件：`id: compaction-basic` 配另一个 name 会被判定不匹配并跳过。更换时禁用旧行，再插入新的 id/name。`config` 整体替换，不能依赖隐含合并。插入行的相对模块路径以 patch 所在目录为基准。

源码：[patch 操作](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/vendor/include/src/patch.ts)、[相对路径处理](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/boot/app-boot/src/index.ts)。

## 4. 最小运行时保留与禁用项

`sdk-minimal` 自己声明完整 Cordis 树，不基于 dsh-base，也未自动带入全部 Skill、插件管理器等能力。但是它仍包括终端、文件和原生 DeepSeek 模型等默认行，需要业务 patch 禁用。

保留 Agent loop、agent、tools、native executor、llm、session、projection、working-directory 内部服务、token-meter、JSONL sessions、checkpoint policy、SDK app/server。禁用模型可调用的 `persistent-bash`、`persistent-pwsh`、`terminal-bash`、`terminal-pwsh`、`tool-fs`、`tool-working-directory`；现有网关路由另行替换 `llm-deepseek`，并禁用 `session-log-deepseek`、`plugin-package-inventory-deepseek`。无图片业务时可禁用 `image-offload` 和 `deepseek-llm-api-extensions`。

内部 filesystem、sandbox 不等于模型文件读写工具，不能仅看名称把内部依赖服务全部删除。业务插件还应验证启动后的实际工具集合，并在执行层拒绝越界工具；仅在提示词里要求不使用 shell 没有同样的约束力。

源码：[sdk-minimal 配置全表](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/bundle/sdk-minimal/cordis.patch.yml)、[工具注册和执行契约](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/contracts.ts)。

## 5. 现有 Chat Completions 网关

使用 `@deepseek-ai/dsh-llm-pi-ai`，为法律任务配置命名路由：

```js
{
  providers: {
    'legal-gateway': {
      api: 'openai-completions',
      baseURL: 'https://gateway.example/v1',
      apiKeyEnv: 'LEGAL_MODEL_KEY',
      models: [{ id: modelId, name: modelId, contextWindow: 32768, maxTokens: 4096 }],
    },
  },
}
```

原生 `dsh-llm-deepseek` 使用不同的 Messages 协议，不应直接把现有 `/chat/completions` 网关填进去。`compat.thinkingFormat` 等字段必须按实际模型协议验证，不能一律设成 deepseek。密钥引用走 credential seam / launchEnvironment，缺失命名变量会失败。通过 Cordis loader 装载此插件，避免绕开它对 providers 等配置的标准化。

源码：[pi-ai 配置](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm-pi-ai/src/config.ts)、[鉴权解析](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm-pi-ai/src/auth.ts)、[适配器](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm-pi-ai/src/adapter.ts)。

## 6. 新经验通过 Skill provider 按需加载

装入 `@deepseek-ai/dsh-skill` 与 `@deepseek-ai/dsh-tool-skill`，不用文件系统 Skill scanner，也不扫描本机旧 Skill。业务数据库提供候选摘要和正文：

```js
ctx.skills.registerProvider(control => ({
  name: 'legal-memory',
  async list({ cwd, signal }) { return frozenCandidates; },
  async get(candidate, { cwd, signal }) { return frozenDefinition(candidate); },
}));
```

`registerProvider` 参数是工厂函数，不是普通 provider 对象。候选包含 `name/description/provider/source/invocation/rank/locator`；invocation 使用 `{ modelInvocable: true, userInvocable: true }`；definition 在摘要字段之外带 `content`。数据库资源使用 opaque resourceBase，并让模型通过法律业务资源工具获取，不能伪装为任意本地文件读取。

Lookup options 只有 `cwd, signal`，没有可随意使用的 `agent` 或 `scope`。任务绑定必须通过独占 runtime 中的闭包或任务工作目录清单实现。调用 `control.invalidate()` 可使后续列表失效，但运行中的审查应继续使用冻结版本。法律结论、律师反馈和用户提供文本都属于业务数据，不能自动升级成可执行 shell 指令或越权操作许可。

来源：[Skill 包](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill)、[tool-skill](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/skill/tool-skill)。

## 7. 法律会话压缩

`BasicCompactionEngine` 从 `@deepseek-ai/dsh-compaction-basic` 具名与默认导出，可继承并覆盖 protected `summarize(input, agent, signal)`。保留上游压缩触发、事件和持久化逻辑，只替换摘要提示及模型调用。摘要应保留当事人、日期、金额、义务、已查条款、证据和出处、已完成动作、未解决问题、待用户回答内容。

默认压缩提示面向编码；默认 `headroomTokens` 为 65536，如果网关上下文只有 32768，会出现不合理预算。应明确设置，例如 headroom 4096、摘要输出 2048、thresholdRatio .8、retainRatio .16，并按实际模型容量核验。

覆盖方法返回 `{summary, rawOutput, provider, model, maxTokens, usage?, llmStreamCall:true}`；使用 `ctx.llm.stream` 并标明 purpose 为 compaction，才能把摘要调用和消耗保留在真实计量路径。SummarizationInput/SummaryResult 未由包根公开导出，应用代码宜使用结构类型或方法类型推导，不虚构公共导出。

源码：[压缩引擎](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/compaction-basic/src/index.ts)、[summarizer](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/compaction-basic/src/summarizer.ts)、[默认预算](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/compaction-basic/src/config.ts)。

## 8. 追问、计量和取消

sdk-minimal 追问需加入 user-questions 服务与 tool-ask-user，SDK 设置 onUserQuestion 回调。业务服务器持久化问题，让界面回答后再恢复等待；不应长期占用一次浏览器 HTTP 请求。必须等待回答时选 legacy 阻塞模式；timed 模式可能在超时后自行继续。

固定版本 JSON-RPC 只支持 initialize、session/prompt、session/query、session/resume、session/wait、working-directory/get/set、shutdown；没有 session/cancel、abort 或 interrupt 方法。应用每任务独占 runtime 时可用 harness.close 终止该进程并记录取消状态。插件内可调用 `agent.cancel({kind:'hook', reason})`；外部取消、步数/费用/时间限制可以由任务绑定插件检查后转成 Agent.cancel。

`agent/pre-step` 事件载荷含 agent/messages/signal/modelSelection/turn/step，属于 waterfall，转交时必须调用或返回 next。`session/event` 回调签名为 `(session, event)`。可用 step/start、assistant/message、assistant/attempt、tool/call、tool/result、llm/retry、turn/end 记录过程；请求计量应包含失败流、重试和压缩。单独的 step/start 数并不等于真实模型请求次数。

源码：[SDK 服务端方法表](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sdk/server/src/server.ts)、[Agent 契约](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent)、[会话事件](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session)、[问题桥接](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/interaction/user-questions)。

## 9. 官方法律资料检索

固定源码未发现 Brave Search provider。可将 Brave 接到自有法律检索工具，并用受控官方域名列表、独立正文抓取和效果日期核验约束返回内容。摘要片段不能作为已核验法律正文。

上游 web-fetch-http 有大小、时限与同源跳转限制，但允许 private/loopback 地址，因此不能直接作为面向合同审查的任意 URL 访问工具。应用应限制 HTTPS、官方域名及解析后的地址，重新验证重定向，拒绝私网与本机地址，保存 URL、发布机关、正文、发布时间、效力状态和抓取时间。仅暴露法律 search/fetch 工具，不挂通用 dsh-tool-web。

源码：[web 类型](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/web/web/src/types.ts)、[HTTP 抓取实现](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/web/web-fetch-http)。

## 10. 已执行验证与尚未证明的内容

1. 已从官方固定提交下载 41,833,274 字节 tarball 并提取实际源码；解包的 Windows 符号链接例外见前文。
2. 使用 tsx 导入官方 SDK TypeScript 入口成功，导出包括 DeepSeekHarness/HarnessClient/HarnessSession 及协议错误类型。
3. 使用仓库已下载的 esbuild 0.28.2 将官方 SDK 入口构建为 `packages/sdk/client/lib/index.js`，286,944 字节；纯 Node 导入成功。这是研究构建，不等于通过上游完整构建或官方发行验证。
4. SheetJS CDN 的 pnpm 直连超时已解决：只对进程设置 `HTTPS_PROXY/HTTP_PROXY` 为系统代理后，`pnpm store add https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` 成功缓存 URL 依赖；加入本地 tarball 的缓存键不同，不能代替此操作。后续冻结 lockfile 离线安装已链接 1152 包，但长研究目录在 micromark 包补丁阶段触发 Windows ENAMETOOLONG，退出码为 1；不能报告完整安装通过。临时 subst 盘符会被 pnpm realpath 还原，未解决路径长度，已移除。
5. `.local/harness-upstream/source-smoke.mjs` 已实际通过：纯 Node 导入已编译 SDK，由 SDK 自动启动官方源码 CLI/sdk-minimal，pi-ai 接入本机模拟 Chat Completions SSE 网关，模型请求 legal_ping、工具成功执行、下一次模型返回完成。共两次模型 HTTP 请求，暴露工具仅 legal_ping，tool/result 的 isError 为 false，finishReason 为 completed，stderr 为空。未使用真实模型密钥或联网推理。
6. 插件放在外部临时目录时，无法解析 `@deepseek-ai/dsh-tools`，上游仅记录 activation warning 并继续启动；模型随后得到 unknown tool。放到上游 `apps/cli/legal-extension/` 后成功。业务应用必须有独立的启动工具校验，不能把初始化握手成功当成所有自定义插件已经激活。

SDK 研究构建命令（固定源码根目录）：

```powershell
node node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild `
  packages/sdk/client/src/index.ts --bundle --platform=node --format=esm `
  --target=es2024 --tsconfig=tsconfig.base.json `
  --outfile=packages/sdk/client/lib/index.js
node ../source-smoke.mjs
```

esbuild 直接使用 tsconfig.base.json 的 paths 解析工作区别名，无额外解析插件。官方 tarball SHA256：`44926eb97c791d1b7a640a0146aa1c522aae7c21a8e238576820d01445cff976`。

完整原生 runtime 构建、正式发行闭包、真实网关的 reasoning/tool-call 兼容、并发与异常断电恢复、法律质量以及费用改善，均须独立验证。MIT 许可允许复用，分发时保留版权、许可及相应第三方声明。

来源：[MIT License](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/LICENSE)、[官方构建入口](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/scripts/build.ts)。

## 11. 产品插件、压缩与恢复的真实执行补记

以下使用固定官方 SDK + 源码 CLI + 本机模拟 SSE 网关，不访问真实模型。研究 fixture 位于 `.local/harness-upstream/`，支持 `LEGAL_HARNESS_ROOT` 指定另一份已准备好的同版本运行时。fixture 会在该运行时的 `apps/cli/legal-extension/` 写入测试插件，运行间应顺序执行。

| Fixture | 实际覆盖与结果 |
| --- | --- |
| `source-smoke.mjs` | 两次模型请求，单一 legal_ping 成功，SDK completed；纯 Node 启动父进程。 |
| `product-smoke.mjs` | 复制当前产品 plugin.mjs/compaction.mjs，加载全部 12 个业务工具加 skill；第一步 skill 加载数据库式 provider 正文，第二步 read_skill_resource 经 HTTP bridge 获取固定版本方法，第三步模型完成。nested object schema、opaque resourceBase、启动白名单均通过，stderr 为空。 |
| `product-smoke.mjs`，`SMOKE_END=question` | 模型一次调用 request_information，业务返回 questionId，产品工具调用 exec.concludeTurn()；直接 completed，无额外模型请求。 |
| `product-smoke.mjs`，`SMOKE_END=submit` | 模型一次调用 submit_review，模拟业务返回 submitted:true；同样由工具结束轮次，仅一次模型请求。此用例不替代业务结果校验测试。 |
| `compaction-restore-smoke.mjs` | 复制实际产品压缩类；首轮模型调用工具并完成，第二轮在测试 pre-step 中通过官方 compactIfNeeded(context-overflow) 强制触发摘要，实际替换约 18,122 个估算 token 的旧历史。关闭子进程后新建 SDK、resumeSession 同一 ID，继续请求保留 checkpoint 与 CONTRACT_ALPHA，旧大段正文不再进入模型上下文。共 5 次 HTTP 请求，其中 1 次摘要，最终 RESTORED_OK，stderr 为空。 |

压缩 fixture 采用测试插件强制触发，证明官方压缩事件、产品摘要类和持久化恢复实际可用；它未证明默认压力阈值已经针对真实合同调优。

可重放命令（项目根目录）：

```powershell
# 可选：指定另一份已经安装并编译SDK的固定版本 runtime。
$env:LEGAL_HARNESS_ROOT = (Resolve-Path '.local/legal-harness').Path
node .local/harness-upstream/source-smoke.mjs
node .local/harness-upstream/product-smoke.mjs
$env:SMOKE_END = 'question'
node .local/harness-upstream/product-smoke.mjs
$env:SMOKE_END = 'submit'
node .local/harness-upstream/product-smoke.mjs
Remove-Item Env:SMOKE_END
node .local/harness-upstream/compaction-restore-smoke.mjs
```

本次产品插件 mock 发现并反馈修复了三个实际兼容错误：nested object 必须显式设置 additionalProperties；开放 object 转 json 时不能留下 description:undefined；agent/pre-step 必须委托 next。修复后的产品源文件直接复制运行，已无需研究 fixture 的临时修复开关。

### 实际 usage 通知结构

```js
{
  method: 'session.event',
  params: {
    sessionId: '...',
    event: {
      type: 'assistant/message',
      seq: 10,
      data: {
        turn: 1,
        step: 1,
        usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
        message: { /* assistant 输出及模型来源 */ },
        stream: [ /* 其中也可能包含 type:chunk/chunk.type:usage */ ],
      },
    },
  },
}
```

没有独立的 `event.type === 'usage'` 事件。不要同时累计 assistant/message.data.usage 与同一事件内 stream 的 usage，否则重复计量。失败的 assistant/attempt 没有顶层 data.usage，可在其 data.stream 查找已收到的 usage chunk；供应商没有报告的消耗应标记未知，不能伪造为零。

摘要实际通知为 `event.type === 'compaction/summary'`，`data` 包含 `provider/model/maxTokens/llmStreamCall:true/usage`。本次 mock 的 maxTokens 为 6000，usage 为 `{inputTokens:100,outputTokens:20,totalTokens:120}`。compaction/end 仅保存生命周期及可能的 error，不含摘要用量。请求总数仍由业务模型代理统计所有真正发出的请求，包含重试和摘要；token 用量依赖供应商返回。

对应源码：[assistant 事件契约](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/types.ts)、[压缩事件契约](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/compaction/compaction/src/types.ts)、[SDK 转发](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sdk/server/src/server.ts)。

## 12. 可入库 fixture 与默认 runtime 的验证

三个研究 fixture 已整理到可入库目录 `scripts/fixtures/harness/`，说明见该目录 README.md。脚本从自身位置解析项目根目录，默认加载 `.local/legal-harness`；支持 LEGAL_HARNESS_ROOT。每次运行使用独立 `.local/harness-smoke/<case>-<uuid>/` 保存 patch 与会话，不向源码目录写入测试状态；测试模块放在指定 runtime 的独立 apps/cli/harness-fixtures 子目录。传给子进程的环境变量经过允许列表筛选，只含系统运行信息及假测试凭据，mock 服务检查这些固定假凭据。

2026-11-06 默认短目录构建期间，pnpm added 1433/1434 的唯一缺失项经只读扫描确认为 `@anthropic-ai/claude-agent-sdk-win32-x64@0.3.263`；官方 registry 元数据解包大小为 218,746,592 字节。SheetJS 已在安装目录存在，不是当时剩余项。检查期间未停止或修改构建进程；随后缺失包与 legal-runtime.json 均已出现，manifest 声明固定提交、正确 archive SHA256、SDK 路径与 official-source-cli 部署方式。

在默认 `.local/legal-harness` 上，可入库的 product-smoke 与 compaction-restore-smoke 已再次实际通过：13 个工具、Skill/资源工具链成功；压缩替换约 18,129 个估算 token 的旧历史，重启恢复后返回 RESTORED_OK，摘要包含于 5 次模型 HTTP 请求，stderr 为空。这验证了默认短目录实际运行，不等于完成官方全量 build:artifacts 发行构建。

推荐常用命令：

```powershell
node scripts/fixtures/harness/source-smoke.mjs
node scripts/fixtures/harness/product-smoke.mjs
node scripts/fixtures/harness/compaction-restore-smoke.mjs
```

若将来完整安装在大平台包下载处失败，应在当前安装退出后，通过适用代理重试构建或先用同版本 pnpm store add 精确包版本补缓存；不要删除已完成的安装或覆盖固定 lockfile 来绕过下载。
