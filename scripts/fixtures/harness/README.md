# 官方 Harness runtime 冒烟验证

这三份 fixture 使用真实官方 SDK、CLI 与 sdk-minimal，仅把模型网关和业务工具服务换成本机 HTTP mock。无真实模型请求、真实密钥或数据库写入。业务工具清单来自当前产品代码。

前置条件：Node >=24.9，已经执行 `npm run harness:build`。默认 runtime 位于项目根目录的 `.local/legal-harness`，也可通过 `LEGAL_HARNESS_ROOT` 指定另一份已准备好的固定版本源码 runtime。运行状态、patch、会话日志保存到 `.local/harness-smoke/`；测试扩展放在指定 runtime 的 `apps/cli/harness-fixtures/`，每次使用独立目录。

在项目根目录依次运行：

```powershell
node scripts/fixtures/harness/source-smoke.mjs
node scripts/fixtures/harness/product-smoke.mjs
$env:SMOKE_END = 'question'
node scripts/fixtures/harness/product-smoke.mjs
$env:SMOKE_END = 'submit'
node scripts/fixtures/harness/product-smoke.mjs
Remove-Item Env:SMOKE_END
node scripts/fixtures/harness/compaction-restore-smoke.mjs
```

- `source-smoke.mjs`：模型请求 legal_ping、执行成功、模型完成，验证两次请求及 usage 通知。
- `product-smoke.mjs`：复制实际产品插件，验证所有业务工具 DSL、工具白名单、Skill provider、skill → read_skill_resource → 完成。两种 SMOKE_END 模式分别验证追问和提交工具成功后直接结束轮次。
- `compaction-restore-smoke.mjs`：复制实际产品压缩类，通过测试专用 pre-step 强制调用官方压缩 API，验证摘要 usage、checkpoint 替换旧历史、关闭进程后 resumeSession 恢复。它不验证默认自动压缩阈值或法律结论质量。

SDK 子进程只接收系统运行所需的环境变量及 mock 参数，父进程的模型密钥与代理环境不传入。mock 服务器校验固定测试凭据。用例只模拟 submit_review 的成功业务响应，不替代后端对引用、全文覆盖及审查结果的业务校验。

这些是依赖已构建 runtime 的显式冒烟用例，未加入普通单元测试默认入口。出现启动失败时会打印固定版本 SDK 的 stderr 诊断；此内部字段仅供 fixture 使用。
