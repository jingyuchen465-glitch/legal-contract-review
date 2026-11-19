# Agent 交接：录音反馈修复与上线

更新日期：2026-11-06（北京时间）。当前部署与引擎切换见 [Harness 上线记录](Harness上线记录-20261106.md)。下文保留前序历史记录；其中旧预分析、经验发布和仅切回旧应用的说明不适用于当前引擎。

## 最新发布：DeepSeek Harness（2026-11-06 13:14）

当前线上 `20261106-044206-harness`，持久运行时 `/opt/legal-contract-review/runtime/harness-fcc0ad46`；新增迁移 017 已执行。新任务通过官方 SDK 和法务业务工具自主审查，旧资产停止加载，历史合同、报告和人工记录保留。切换前后业务指纹一致，89 项单元及 56 项集成、真实模型完整审查、公网登录与桌面/手机检查通过。Brave 密钥未配置，法律质量留出集未验收。

正式备份、发布证据及历史离线归档位置见上线记录。当前迁移后的数据不能直接启用旧 Worker；须遵守该记录中的一致性恢复要求。下列“当前状态”及发布均为前序工作历史。

## 当前状态

- 用户已授权：针对八类录音反馈使用 Matt 方法测试修复，并把修复部署到现有正式站点。
- 录音反馈修复通过 47 项基础测试、75 项集成测试及浏览器关键流程；后续编辑器更新基础测试增至 50 项，生产构建及浏览器验收通过。编辑器更新未重跑 75 项集成测试；保存保护的浏览器场景使用测试替身，不能算真实编辑保存联调。
- 当前线上：`20261105-contract-skills-053111`；按合同聚合一个综合技能，后续确认更新原技能版本。前序预分析、联合审查、PDF 转 Word、分类整理及最终结论引导随当前线上基线保留。自动整理保持开启。
- 本轮服务器 106 项单元、126 项集成测试及生产构建通过；服务器跳过的浏览器用例已使用相同构建资产在本机 Edge 通过，综合技能专项 13 项全部通过。公网聚合、分类导航、390 像素布局及 30 个静态资源哈希通过；详见[综合技能上线验收](综合技能上线验收-20261105.md)。
- 正式站点：<https://legal.bi.youmeibi.com>。API、Worker、格式转换、OnlyOffice 已有部署；真实模型及编辑器的历史部署验收不代表本轮法律意见质量已验收。
- 工作区含前序会话留下的大量未提交修改。本轮采用线上当前版本的增量发布，保留原有工作；尚未提交或推送 Git。线上版本不能仅用 Git HEAD 判断。

## 当前发布：一合同一综合技能（2026-11-05 13:38）

用户明确要求上线。本轮基于 `20261105-collapse-first-030256` 增量发布 28 个相关文件，执行迁移 015；生产环境配置和自动整理开关保持原样。现有 10 个审查点聚合成一个默认折叠入口，合同经验技能按大类及具体类型组织；统一采纳、编辑、审核发布整个综合技能，旧任务固定原文件版本。原始提案、证据、历史结论和已有正式方法保留。

数据备份 `/srv/legal-contract-review/application/backups/backup-2026-11-05T05-38-15-354Z-280b37`，清单 44 个文件。切换前后八类业务记录指纹一致，API、Worker、转换服务、PDF 转 Word 和 OnlyOffice 正常。未替法务采纳提案或发布法律标准。回退仅切回前版应用并重启，保留迁移 015、技能文件及历史业务数据。

发布目录 `/opt/legal-contract-review/releases/20261105-contract-skills-053111`；证据归档 `deployment-records/20261105-contract-skills-053111`，本机 `.local/contract-skills-deploy/`。文件备份需包含 `objects/` 与 `skills/`，运行机制见[一合同一综合技能](一合同一综合技能-20261105.md)。

## 前版：最终结论确认引导修复（2026-11-04 17:37）

用户报告点击“确认并保存结论”后提示“请确认当前版本分类及我方立场”。只读核实受影响合同 v4：分类及立场未确认、9 项意见待处理，预审已完成且无最终结论。通过真实 Edge 与内存 API 复现：旧页面仍允许提交，收到 409 后没有直接恢复入口；回归脚本修复前报 `classification error must offer a direct recovery action before submission`。

现于结论弹窗明确列出分类／立场、未处理意见、编辑保存和预审完整性等前置步骤，提供“去确认分类与立场”“去处理审查意见”“保存并返回”入口，未完成前禁止提交。条件和理由标明必填／选填，跳转保留填写内容；服务器因并发变化拒绝保存时，在弹窗显示错误并刷新前置状态，用户核对后重试。后端法务校验保持原样，不代替用户确认分类、处理风险或保存结论。

- 发布 `/opt/legal-contract-review/releases/20261104-decision-guidance-093622`；前版及回退目标 `/opt/legal-contract-review/releases/20261104-guided-offline-learning-085838`。
- 仅覆盖 `frontend/src/pilot/Review.vue`、新增 `scripts/decision-ui-qa.cjs`；继承并核对前版源码与文档哈希，依赖和后端无变更，无数据库迁移。
- 正式备份 `/srv/legal-contract-review/application/backups/backup-2026-11-04T09-37-36-856Z-20afe9`，44 个文件。迁移／业务数量及自动整理开关均保持一致；API、Worker、Converter active，公网及 OnlyOffice 健康通过。
- 本机及服务器生产构建、81 项基础测试通过；本机和公网发布资源上的真实 Edge 验证分类确认、意见处理、保留结论草稿、并发变化恢复、正常保存及窄屏。该新回归脚本的 API 为内存替身，不写正式合同、结论或经验，不调用模型；本次前端改动未重跑 93 项后端集成，前版已通过。
- 公网真实账号登录、台账、技能及经验整理、既有审查详情通过；只读复查受影响合同仍为待确认及 9 项未处理，没有代操作。
- 证据：本机 `.local/decision-confirmation`；服务器 `deployment-records/20261104-decision-guidance-093622`，包含原包哈希、文档独立回执、构建／激活日志、浏览器和最终检查结果。

复测：设置 Playwright 所在 `NODE_PATH`，运行 `node scripts/decision-ui-qa.cjs`；可设置 `DECISION_QA_BASE=https://legal.bi.youmeibi.com` 验证正式构建资源，全部业务 API 仍由浏览器内存替身接管。回退时停 API／Worker，原子恢复前版 current 指针再重启，无需回退数据库。

## 前版：异步预分析与本机修改稿对比学习（2026-11-04 17:05）

用户明确要求“上线先”，已完成正式备份、迁移和原子切换。保留原台账与侧栏结构及现有业务功能，沿用上游白底、黑灰文字、蓝色按钮风格。上传后后台预分析，用户确认主体、立场、模板、审查点和目的后开始正式审查；普通审查可使用内置检查项，不再要求先发布规则。格式转换独立排队，模型 408 有限重试，预分析中断可恢复并展示具体错误。

本机下载修改后，在同一合同上传修改版本；最终确认后，后台对照直接上一版整理待确认提案，旧稿无需系统内人工复核记录。支持新增、删除、修改的双方正文及分页查看，长文成对分片。未记录修改原因时标为待确认；法务采纳并发布后才进入后续审查。正文之外的排版、图片及未识别内容需核对原件。

| 项目 | 实际结果／位置 |
|---|---|
| 当前发布 | `/opt/legal-contract-review/releases/20261104-guided-offline-learning-085838` |
| 前版／回退目标 | `/opt/legal-contract-review/releases/20261103-contract-skills-143301` |
| 发布包 | `source-20261104-guided-offline-learning-085838.tar.gz`；SHA-256 `2a43fbbaf3ff66e4b30e78a4d1659f9f8204b6943700a44e671ed09855d8f560` |
| 发布范围 | 68 个增量文件，校验 199 个基线源码；锁定安装 `diff@8.0.2`，登记依赖许可；文档另存独立哈希回执 |
| 数据库 | 新增 `011_preanalysis.js`；迁移前后合同 15、版本 29、审查 32、结论 0、意见 82、技能 0、经验任务 0 均一致；自动整理保持 `true` |
| 正式备份 | `/srv/legal-contract-review/application/backups/backup-2026-11-04T09-05-37-971Z-a546a4`，44 个文件；配置和前版指针在 `deployment-backups/20261104-guided-offline-learning-085838` |
| 验证 | 本机 81 项基础、10 项相关集成及构建；服务器 81 项基础、93 项完整集成及生产构建均通过；公网 Edge 只读页面验证通过；真实 OnlyOffice 持续连线回归通过，文档版本未变 |
| 真实模型 | `gpt-6.1-sol` 在独立虚构验收库调用 2 次，产生 1 条引用两稿证据的提案，发布后后续审核加载成功；验收库已删除，没有写正式技能库 |
| 运行状态 | API、Worker、Converter 均 active；公网 API、转换器和 OnlyOffice 健康正常；未发送钉钉消息或回传附件，未批量回填历史合同 |
| 证据 | 本机 `.local/deploy-offline-learning`、`.local/skills`、`.local/office-links`；服务器 `offline-learning-{prepare,activation}.log`、`offline-learning-live-state.json`；归档 `deployment-records/20261104-guided-offline-learning-085838` |

回退仅切回上述前版应用并重启 API／Worker；保留新增表和全部业务数据，不执行破坏性数据库回滚。前版不提供预分析页面，回退期间暂停新上传并人工核对待处理合同。真实法律质量仍待法务独立标注验证；版本切换保存保护的浏览器场景使用替身，不代表真实修改保存回调联调。

## 前版：合同经验技能包与自动沉淀

已实现并上线用户确认的技能包方案；先以关闭状态执行迁移和空库验收，2026/11/3 22:41:16 开启自动整理。正式技能库初始为空，没有预生成技能或批量整理历史合同。最终确认后自动生成待确认提案，法务编辑、采纳并发布后才影响新建预审。

| 项目 | 实际结果／位置 |
|---|---|
| 当前发布 | `/opt/legal-contract-review/releases/20261103-contract-skills-143301` |
| 前版／回退目标 | `/opt/legal-contract-review/releases/20261103-version-switch-205401` |
| 发布包 | `source-20261103-contract-skills-143301.tar.gz`；SHA-256 `19494b73cc398b42063c1abacc1e089bfca7f693a48b57b1b1cbaa097616ae6f` |
| 发布范围 | 23 个增量文件，继承校验 156 个基线源文件；最终清单增加两份交接文档回执，无依赖安装变更 |
| 数据库 | 新增迁移 `010_contract_skills.js`，技能版本及经验任务表；保留全部已有数据，初始技能 0、任务 0、自动整理关闭 |
| 迁移前备份 | `/srv/legal-contract-review/application/backups/backup-2026-11-03T14-38-43-251Z-df3836`，44 个文件；配置及前版指针在 `deployment-backups/20261103-contract-skills-143301` |
| 验证 | 服务器 55 项基础、83 项集成测试及生产构建通过；Edge 技能编辑采纳发布闭环通过；真实模型 gpt-6.1-sol 在独立虚构验收库生成 1 条提案，3 次实际请求，后续审核加载 1 个技能包 |
| 线上验证 | 空技能库、默认关闭、没有历史回填、旧报告空快照及窄屏通过；持续连线与版本切换回归通过；版本保存保护仍采用浏览器替身，不代表真实保存联调 |
| 证据 | 本机 `.local/skills`；服务器 `skills-{release,initial-state,model-smoke,ui-result,live-result,live-enable-result,links-browser-result,version-switch-browser-result,docs-receipt,final-check}.json`，`skills-prepare.log`、`skills-activation.log`；归档 `deployment-records/20261103-contract-skills-143301` |

**接手入口：**涉及技能包、经验任务、模型加载或回退时先读 [合同经验技能包与自动沉淀](合同经验技能包与自动沉淀.md)，其中列出数据表、接口、状态流、快照、权限和复测命令。业务技能存数据库并支持 Markdown 导出，不保存到本机 Codex 的技能目录，也不调用 Codex。经验任务复用现有模型与事务消息队列。

**已完成：**通用＋合同类型技能管理；提案编辑、采纳、忽略；来源及结论语境；新标准进入规则草稿；规则依赖阻止提前发布；三种最终结论；任务去重及重试；草稿并发保护；创建时冻结候选、分类后匹配；请求、缓存、报告及评测技能快照。刚处理完的任务保持可见，可继续打开草稿。

**待完成／边界：**仍需法务用独立标注样本核对实际建议及质量变化。真实模型闭环验证使用完全虚构的结构化原文和人工处理，临时发布仅存在于独立验收库，验收库已删除；没有把测试技能放进正式库。机械校验不等于完全脱敏或可靠的语义去重。复杂 Word 文件变化仅按可核实文字标记，不推测条款对应及修改原因。独立技能草稿评测、公司模板库、工商核验和钉钉回传等能力边界沿用各自记录。

**回退：**先在反馈中心关闭自动整理，再停服务、恢复上述前版应用指针并重启。保留 `la_skill_versions`、`la_learning_tasks` 及其数据；迁移 down 主动拒绝删除业务表。回退旧应用后技能不会继续参与预审。队列测试原来只等待 10 秒，在服务器约 17 秒才能排空，已将测试等待上限改为 45 秒；没有放宽业务校验。

## 前版：编辑时安全切换版本和预审（20:55）

| 项目 | 实际结果／位置 |
|---|---|
| 当前发布 | `/opt/legal-contract-review/releases/20261103-version-switch-205401` |
| 上一发布／回退目标 | `/opt/legal-contract-review/releases/20261103-persistent-links-204047` |
| 发布包 | `source-20261103-version-switch-205401.tar.gz`；SHA-256 `f05b00cc4ad5229c40d1da233044ec300a5d5864e225b763a75a84cf924ef599` |
| 发布范围 | 4 个文件；校验 155 个基线文件，保留 152 个继承文件，最终 156 个源文件；无依赖或数据库迁移变更 |
| 数据备份 | `/srv/legal-contract-review/application/backups/backup-2026-11-03T12-54-57-633Z-d13bac`，44 个文件 |
| 配置和前版指针 | `/opt/legal-contract-review/deployment-backups/20261103-version-switch-205401` |
| 测试 | 本地和服务器 50 项基础测试及生产构建通过；正式发布资源上验证选择器及浏览器保存保护场景，持续连线回归通过；本次未重跑集成测试 |
| 证据 | 本机 `.local/office-links/version-switch-*`；服务器 `/opt/legal-contract-review/version-switch-{release,browser-result,links-browser-result,docs-receipt,final-check}.json` 和 prepare／activation 日志；归档 `deployment-records/20261103-version-switch-205401` |

根因：`Review.vue` 的两个原生下拉框原为 `:disabled="editor"`，进入在线编辑后直接禁用且无解释。现在选择器保持可用；选中其他版本／预审或点击“返回最新”时，先请求保存并等待确认，再退出编辑到所选原文预览。选择预审同时选择它对应的文件。受控选择器在保存完成前保持旧值；保存失败或期间又有输入时保留编辑器，提示重试。只在加载或切换中暂时锁定。主动查看历史时不跟随后台刷新。

实现入口：`Review.vue` 的 `switchSelection`、`OfficeWorkspace.vue` 的 `saveForNavigation`；路由离开保护也复用“保存期间无新增修改”的检查。切换目标读取失败时不拆除编辑器；成功前不会更改其源版本。

回归脚本 `scripts/office-version-switch-ui-qa.cjs --live`：先在真实 OnlyOffice 中确认编辑状态的两个选择器可用，再用实际 Vue 组件及**浏览器内 DocsAPI／保存接口替身**覆盖保存失败保持编辑、保存期间新增输入阻止切换、成功后显示历史且定时刷新保持、预审匹配文件版本和返回最新。替身请求不写正式数据库。仍使用持续连线的虚构样本，正式合同未修改，未验证真实编辑后的保存回调与文件内容一致性。

本轮复测沿用 `.local/office-links/access-persistent.json` 或 `OFFICE_LINK_QA_ACCESS` 指定的私有配置；结果 `.local/office-links/version-switch-browser-result.json`。不带 `--live` 会使用本地构建资产。服务器最终源码清单叠加两份交接文档的独立哈希回执，应用代码不再修改。

## 前版：无需点击的持续连线（20:42）

| 项目 | 实际结果／位置 |
|---|---|
| 前版发布 | `/opt/legal-contract-review/releases/20261103-persistent-links-204047` |
| 上一发布／回退目标 | `/opt/legal-contract-review/releases/20261103-office-links-200801` |
| 发布包 | `source-20261103-persistent-links-204047.tar.gz`；SHA-256 `2c61a28c9cc4158137188cf942a1f8131f5802c0b8c322a5be9ddc154ef7f16e` |
| 发布范围 | 5 个文件；校验 155 个基线文件，保留 150 个继承文件，最终 155 个源文件；无依赖或数据库迁移变更 |
| 数据备份 | `/srv/legal-contract-review/application/backups/backup-2026-11-03T12-41-57-180Z-2322f3`，44 个文件 |
| 配置和前版指针 | `/opt/legal-contract-review/deployment-backups/20261103-persistent-links-204047` |
| 测试 | 本地和服务器 50 项基础测试及前端构建通过；真实线上浏览器使用正式发布资源验收；本次未重跑 75 项集成测试 |
| 虚构验收样本 | 合同 `f60dc711-44ff-464e-86f7-6dd29c917027`；预审 `683dbb4e-54d7-4154-978d-c08183db92fa`；版本 `06d71bcc-af44-4739-96eb-69c4ab4260ae`；人工构造验收意见，不调用模型 |
| 证据 | 本机 `.local/office-links/persistent-*`；服务器 `/opt/legal-contract-review/persistent-links-{release,browser-result,docs-receipt,final-check}.json` 及 prepare／activation 日志；文档回执和验收证据存 `deployment-records/20261103-persistent-links-204047` |

打开在线编辑后，可见条款和可见意见卡片自动保持连线，多条意见可同时显示。无需点击标题，也无需选择 Word 批注；点击正文取消选择后仍保留。选中的意见加深连线，定位／高亮和“下一处”仍可用。条款或卡片离屏时隐藏对应线，滚回自动恢复；窄屏隐藏横向线，侧栏再次展开自动恢复。

桥接新增 `readCommentPositions`：调用只读取坐标的 `asc_showComment` 前，同步临时截获 `sync_ShowComment`／`sync_HideComment` 及其编译别名，读取位置后在 `finally` 恢复所有原始属性描述符，避免批量测量派发弹窗事件或改变光标、选择及滚动。约每 80ms 更新一次，仅读取可见卡片对应的可靠锚点。适配仍限定同源 OnlyOffice 8.3.3；升级 SDK 时必须复测此临时截获、人工旁批及选择保持。

浏览器验收覆盖：打开后同时显示两张意见卡片的连线且没有选择任何意见；后台测量不发弹窗事件；取消批注选择后仍连线；其他跨页、缺失条款、滚动、缩放、全屏、人工旁批、侧栏恢复、窄屏及原件未改检查通过。使用虚构样本，未实际编辑保存，也未进行真实模型法律质量验收。

本轮复测设置 `OFFICE_LINK_QA_ACCESS` 为 `.local/office-links/access-persistent.json`，运行 `node scripts/office-links-ui-qa.cjs --live`；该私有文件标记 `persistent:true`、`multiPage:true`，输出 `.local/office-links/persistent-browser-result.json`。无需点击的截图为 `.local/office-links/持续连线-无需点击.png`。其余运行及凭据规则见下方复测章节。

## 前版：点击定位连线（20:09）

| 项目 | 实际结果／位置 |
|---|---|
| 前版发布 | `/opt/legal-contract-review/releases/20261103-office-links-200801` |
| 上一发布／回退目标 | `/opt/legal-contract-review/releases/20261103-feedback-192227` |
| 发布包 | `source-20261103-office-links-200801.tar.gz`；SHA-256 `239036f56a982462e18c84674641abec1e2a90ca9d91a151947453077f9d0eaa` |
| 发布范围 | 5 个文件；校验 152 个基线文件，150 个继承文件保持原哈希；最终源文件共 155 个。依赖不变，无新增数据库迁移 |
| 数据备份 | `/srv/legal-contract-review/application/backups/backup-2026-11-03T12-09-17-746Z-bdcdcf`，43 个文件 |
| 配置和前版指针 | `/opt/legal-contract-review/deployment-backups/20261103-office-links-200801` |
| 服务器验证 | 49 项基础测试和前端构建通过；API、Worker、Converter active，公网健康及 OnlyOffice healthcheck 通过 |
| 浏览器验证 | 使用正式发布资源和真实 OnlyOffice：定位连线、第二／三页引用切换、缺失条款无错误连线、滚动跟随及离屏隐藏、缩放、侧栏收起恢复、全屏、人工旁批保留原生弹窗、文内批注反向选卡、窄屏；无运行错误，原件未改 |
| 虚构样本 | 合同 `29a8d8bf-fd94-458e-8331-b1b26526d110`；预审 `b7dfc3b8-0cd3-4fdd-aad3-2f3dad8b3a8b`；版本 `4e4fb699-e337-4b4b-9b4c-0a8a71c67e6c` |
| 证据 | 本机 `.local/office-links/`；服务器 `/opt/legal-contract-review/office-links-{release,docs-receipt,final-check}.json`、`office-links-browser-result.json`、`office-links-prepare.log`、`office-links-activation.log` |

此版点击意见标题或“定位原文”后才显示选中卡片的连线；该交互已由上方持续连线版本替代。多引用切换、窄屏和离屏隐藏及人工旁批操作保留。当前使用方法见[在线修订与旁批使用说明](在线修订与旁批使用说明.md)。

当前适配同源 OnlyOffice 8.3.3，通过 iframe 的 `Asc.editor` SDK 读取批注及位置；按 AI 作者、标题、理由、建议和完整段落标记唯一匹配。缺失、歧义、修改或删除的批注不强行连线；跨域或不兼容 SDK 会提示定位不可用。8.3 的选中方法不能可靠滚回离屏位置，因此桥接使用原生批注 Y 坐标和 `ViewScrollToY` 同步定位；升级 OnlyOffice 时复测跨页、滚动和人工旁批。

本次仅验证选择、定位和滚动，未实际编辑保存，也不代表真实法律质量验收。测试使用明确标记的虚构三页合同和人工构造的验收结果，不调用模型。应用代码不再修改；上线后两份交接文档另存 `office-links-docs-receipt.json`，最终校验把该回执叠加到初始发布及继承文件清单，记录位于 `deployment-records/20261103-office-links-200801`。

## 前版发布与证据：录音反馈修复

| 项目 | 实际结果／位置 |
|---|---|
| 前版发布 | `/opt/legal-contract-review/releases/20261103-feedback-192227` |
| 上一发布／回退目标 | `/opt/legal-contract-review/releases/20261103-upload-context-134224` |
| 初始发布包 | `source-20261103-feedback-192227.tar.gz`；SHA-256 `d685c064596cf78e51f33de3262fa651e30cb1c1fd9e6a09df37f641dd7fdd40` |
| 发布范围 | 29 个文件；124 个继承源文件保持原哈希；依赖不变，无新增数据库迁移 |
| 数据备份 | `/srv/legal-contract-review/application/backups/backup-2026-11-03T11-25-59-357Z-6debb0`，备份清单 40 个文件 |
| 配置和前版指针 | `/opt/legal-contract-review/deployment-backups/20261103-feedback-192227` |
| 服务器验证 | 47 项基础测试、75 项独立数据库集成测试及前端构建通过，临时测试数据库和角色已清理 |
| 正式浏览器验证 | 登录与 CSRF、正式及示例规则预览、甲方免填公司名及字段保存、修订上传切换、历史选择保持／返回最新、原件哈希、真实批注 DOCX 下载、无同意结论时拒绝下载确认稿；无页面运行错误 |
| 服务诊断 | database、worker、storage、converter、office 均 success；OCR、Milvus 为 unconfigured |
| 虚构验收合同 | `550dd833-7cc8-44c4-8fd8-8b276d152c0a`；两次任务均取消，未调用真实模型 |
| 初次／修订预审 | `3fed6124-cb38-446b-acf6-471900a03ee1`／`3271ea5b-9d78-406c-b170-3ae17d01ee41` |
| 验证证据 | 本机 `.local/cloud-deploy/feedback-{release,smoke,final-check}.json` 及 `feedback-*-live.png`；服务器同名 JSON、`feedback-prepare.log`、`feedback-integration.log`、`feedback-activation.log` |

正式浏览器的新增虚构合同特意留空交易目的，使后台在模型阶段之前停止；随后立即取消任务，并在数据库校验模型调用步骤为 0。完整上传背景、关联材料、确认稿通过等路径由隔离集成和本地浏览器验证；本轮不修改真实合同，不作真实法律质量验收。

本文及逐项报告在上线后补齐交付结果，同步到服务器 `current/docs`，并额外保存在 `deployment-records/20261103-feedback-192227`。文档最终哈希记录在 `feedback-docs-receipt.json`；初始发布包和源码清单保持原样，最终校验将文档回执叠加到原清单，应用代码不变。

## 已修复及能力边界

| 用户反馈 | 已实现 | 边界／后续工作 |
|---|---|---|
| 审核意见空泛、重复 | 拦截空泛失败建议并自动纠正至多两次；要求具体改法和文字；相同意见合并展示、批量处理；保留长合同各片段建议 | 语义近似意见不自动合并；真实法律质量需法务样本验收 |
| 上传处理与版本混淆 | 页面默认跟随最新预审；主动查看历史时保持选择；支持返回最新；展示阶段和最近进展；上传修订稿切换到对应版本及二审；编辑时可选择版本／预审，先保存后退出，失败或新增输入时保留编辑 | 现场卡住的唯一根因未确定，仍需现场文件、网络记录及服务日志；本次保存保护用浏览器替身验证，真实保存回调仍需复测 |
| 编辑与旁批定位 | 接通批注下载；读取原有旁批和修订；保留前导零；在线 Word 中可见条款与意见默认持续连线，多条同时显示；支持定位高亮、多引用切换、滚动缩放跟随和文内反选 | 当前连线适配同源 OnlyOffice 8.3.3；复杂 Word 版式和实际编辑保存仍需样本验收；人工处理意见不会直接改写正文 |
| 二审与最终稿 | 修订稿、在线有效保存、关联材料变更创建新预审；法务确认稿下载绑定同意结论、文件版本及哈希；区分各类导出 | 附条件同意须落实修改、重新审核并同意；确认稿保留原有修订和旁批 |
| 规则与经验 | 上传及背景页预览匹配规则、版本及检查项；重点项进入背景；回归现有反馈案例→规则草稿→发布流程 | 无模型自动学习；公司模板可作关联材料，尚无模板库批量导入、版本管理和自动对比 |
| 复杂合同与格式 | 主合同／模板作为关联背景送审，支持选择材料，快照固定来源和哈希；PDF 可下载 DOCX 文字重建稿 | 关联材料限 32000 字；文字重建不保留图片、签章、表格及精确版式；扫描件需 OCR；未新增补充协议起草及双语正文自动同步 |
| 钉钉流转 | 回归绑定、收件、权限、重试；界面明确人工回传；归档显示来源审批编号 | 本轮未做真实企业应用联调；自动回传、钉钉进度通知待开发；指定归档目录是服务器目录 |
| 信息填写与主体核验 | 支持我方为甲方／乙方，免重复填写公司名；背景按任务保存快照 | 选甲乙方不等于工商核验；企查查等接口未接入 |

## 接手顺序与完成标准

1. 先核对本文发布记录、服务器 `current` 和源码清单。完成标准：确定当前线上版本、待处理业务任务及是否有其他会话的新发布。
2. 优先验收真实模型建议质量和复杂 Word。使用脱敏且获授权的公司样本，记录具体替换文字、重复率、遗漏和证据定位；核对下载稿、原有旁批及修订。完成标准：法务逐项确认，不能用测试替身或“接口成功”替代。
3. 排查现场处理卡住／导出失败。收集具体版本、预审 ID、操作时间、浏览器网络错误及对应 Worker 日志。完成标准：能够复现并有覆盖该行为的回归验证。
4. 按业务优先级推进下表。涉及真实钉钉发送、消息或审批附件写入，先取得用户对该外部动作的明确授权；目前用户只授权本轮修复上线。

| 待完成项 | 所需输入／依赖 | 完成标准 |
|---|---|---|
| 钉钉自动回传和进度通知 | 企业应用、审批权限、附件目标位置和通知对象 | 真实测试审批闭环，权限及重复发送处理通过 |
| 企查查／主体核验 | 服务商、授权凭据、费用及查询字段范围 | 名称错误、主体不存在、接口不可用均有明确结果及可追溯来源 |
| 中英文同步修订 | 双语对应方式、术语库、法务样本 | 修改中文后英文建议可定位、确认，保存下载一致 |
| 补充协议起草 | 主合同、变更事项、输出模板 | 起草引用来源清楚、人工确认后导出，主合同原件保留 |
| 公司模板库 | 成熟模板、适用范围、版本及发布人 | 导入、版本管理、适用匹配、条款对比和人工发布闭环 |
| PDF 保真转换／扫描件 | 认可的转换或 OCR 服务、复杂样本 | 逐页验证表格、图片、签章及可编辑性，明确不能还原的部分 |
| 真实质量验收 | 两类各不少于 20 份法务标注合同、正式规则 | 输出召回、误报、建议可用性等实测结果及法务结论 |

## 代码入口

- 意见质量：`backend/pilot/model.js`、`workflow.js`、`finding-groups.js`；前端 `AnnotationNote.vue`、`Review.vue`。
- Word 读取和批注：`backend/pilot/parser.js`、`word-text.js`、`annotated-contract.js`；前端 `DocumentView.vue`、`OfficeWorkspace.vue`。
- 编辑器连线：`frontend/src/pilot/office-links.mjs` 和 `OfficeWorkspace.vue`；严格匹配与几何测试 `backend/test/office-links.test.js`；真实编辑器验收 `scripts/office-links-ui-qa.cjs`。
- 版本、背景和关联材料：`backend/pilot/contracts.js`、`workflow.js`；前端 `Contracts.vue`、`Review.vue`。
- 新接口：`GET /api/review-plan`、`GET /api/versions/:id/editable-word`、`GET /api/reviews/:id/final-contract`，实现位于 `backend/pilot/routes.js`。接口参数见 `docs/openapi.json`。
- PDF 文字重建：`backend/pilot/editable-word.js`。规则预览：`frontend/src/pilot/ReviewPlan.vue`。
- 新回归：`backend/test/review-quality.test.js`、`source-markup.test.js`；集成 `upload-context.test.js`、`workflow.test.js`。

## 验证与复测

本轮修复采用本机 `C:/Users/Administrator/.codex/skills/ask-matt/SKILL.md` 指向的诊断与 TDD 方法，已执行失败复现→修复→回归。

```powershell
npm test
npm run test:integration
npm run build
npm run openapi
```

集成测试只运行独立随机数据库；不要把正式数据库配置直接交给测试脚本。完整运行方式见[部署与操作手册](部署与操作手册.md)。

本地 Edge 回归：先运行 `node scripts/ui-qa.js --allow-test-fixture`，再执行 `node scripts/feedback-ui-qa.cjs`。后者依赖 Playwright 和本机 Edge，严格限定 `localhost:3001` 隔离夹具，不可改成正式站点直接运行。浏览器已覆盖当前／历史选择、返回最新、修订上传切换、实际批注 DOCX 下载、规则预览和甲方免填公司名。

真实编辑器连线复测：设置 `OFFICE_LINK_QA_ACCESS` 指向被 Git 忽略的验收登录 JSON（本机 `.local/office-links/access-multi.json`），确保 Playwright 和 Edge 可用，运行 `node scripts/office-links-ui-qa.cjs --live`。不带 `--live` 会使用本地构建资产，不能当作线上发布验收。脚本仅接受标题包含“上线验收虚构样本”的合同；输出及截图在 `.local/office-links/`。凭据留在本机文件，不写入交接或日志。

## 线上运行与回退

- SSH：`root@114.55.148.140`；凭据在原交接包 `D:/Developer/阿里云服务器登录信息交接包(1)/keys/server-login.key`。使用现有凭据，本文及日志不记录密钥内容。
- 应用根：`/opt/legal-contract-review`；`current` 为指向 `releases/` 的符号链接；Node 位于 `runtime/node/bin`。
- 环境：`/etc/legal-contract-review/app.env`；数据及备份：`/srv/legal-contract-review/application`；归档：`/srv/legal-contract-review/contracts`。
- systemd：`legal-contract-review-api`、`legal-contract-review-worker`、`legal-contract-review-converter`。API 监听 `127.0.0.1:18090`；OnlyOffice 使用现有容器及 HTTPS `/onlyoffice/`。
- 管理员凭据保存在被 Git 忽略的 `.local/cloud-deploy/initial-admin.txt` 及服务器 `/etc/legal-contract-review/initial-admin.txt`；读取使用，不粘贴到聊天或文档。
- 发布前备份数据库、原件和环境配置，校验当前版本及源文件哈希；候选从当前线上复制后只覆盖清单文件。构建和隔离测试成功再原子切换 `current`，重启本项目 API／Worker。
- 回退时将 `current` 原子切回本次记录的上一发布，重启 API／Worker并检查 HTTPS。本轮无新增数据库迁移；保留业务数据库、新上传原件、原配置密钥及 OnlyOffice 容器。

```bash
readlink -f /opt/legal-contract-review/current
systemctl is-active legal-contract-review-api legal-contract-review-worker legal-contract-review-converter
curl --fail https://legal.bi.youmeibi.com/api/health
curl --fail https://legal.bi.youmeibi.com/onlyoffice/healthcheck
```

本次专用回退命令（确认 `current` 仍为本轮发布后执行）：

```bash
set -e
base=/opt/legal-contract-review
test "$(readlink -f "$base/current")" = "$base/releases/20261103-version-switch-205401"
ln -s "$base/releases/20261103-persistent-links-204047" "$base/rollback-version-switch-205401"
mv -Tf "$base/rollback-version-switch-205401" "$base/current"
systemctl restart legal-contract-review-api legal-contract-review-worker
curl --fail --retry 10 --retry-connrefused --retry-delay 1 https://legal.bi.youmeibi.com/api/health
```

详细发布记录及清单位于本机 `.local/cloud-deploy/` 和服务器 `/opt/legal-contract-review/`。本目录被 Git 忽略，因此本文会保留后续接手需要的非敏感版本、备份、验证结果和限制。
