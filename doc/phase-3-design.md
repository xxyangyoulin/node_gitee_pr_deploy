# 阶段 3 设计:测试执行管线

> 前置:阶段 1-2 已实施(pr_cache 状态机 / poller / AI 评估 / 自动化面板)
> 交付目标:按项目配置测试(服务器/位置/命令,可由 AI 决定命令),自动或手动执行,
> 流式日志与历史,状态回写 pr_cache,面板"发起测试"按钮点亮。

## 1. 数据库:新表 `test_configs`(每项目一条)

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| project_id | PK | |
| server_mode | `ssh` | `local` / `ssh` |
| host / username | 空 | ssh 模式;编辑时下拉建议取自 deploy_targets 去重列表 |
| workdir_template | `~/TEST/{project}_{pr}` | 测试项目位置,支持 `{project}` `{pr}` 变量 |
| commands | 预定义选项 JSON 数组 | 如 `[{"label":"全量","command":"vendor/bin/phpunit tests"},{"label":"单元","command":"vendor/bin/phpunit tests/Unit"}]`,至少一条;第一条为默认 |
| ai_decides | 0 | 开启后由 AI 根据变更从选项中选择 |
| ai_prompt | 空(内置默认) | AI 选择命令的提示词,变量同评估提示词 |
| timeout_sec | 600 | 单次执行超时 |
| created_at / updated_at | | |

`deployment_logs` 增加 `kind` 列(`deploy` 默认 / `test`)与 `pr_number` 列,测试日志复用该表。

## 2. 执行器(server/tester.ts)

```
runTest(project, prRow, config, { manual }) →
  1. 状态守卫:pr_cache.state='testing' 时拒绝(手动/自动互斥);置 testing
  2. 组装命令序列:
     workdir = workdir_template 替换 {project}/{pr}
     cd {workdir}
     [目录不存在] git clone https://oauth2:{token}@gitee.com/{repo}.git .
     git fetch --all --prune
     git checkout -f {head_sha}        ← 用 SHA 而非分支名(分支可能已删/被覆盖)
     {command}                          ← ai_decides 时由 AI 从预定义选项中选择(返回序号),失败/越界回退第一个选项
  3. 执行:ssh 模式 spawn ssh(BatchMode);local 模式 spawn bash -lc
     - 流式输出(复用部署的 chunked 机制)
     - 超时 timeout_sec 强制 kill,记为失败"执行超时"
     - 退出码非 0 → 失败
  4. 落库:deployment_logs(kind='test', pr_number, output, success)
  5. 回写 pr_cache:test_passed / test_failed(仅当 state 仍为 testing,防竞态)
```

并发控制:同项目同时只跑一个测试(执行器内按 projectId 锁);全局并发 2。

AI 选择命令的安全边界:AI 仅输出选项序号(JSON {"command_index": N}),命令本体全部
来自用户预定义列表——不存在自由生成 shell 的注入面。序号越界/解析失败/超时回退第一个
选项,日志标注"AI 选择失败,使用默认"。

## 3. 自动触发链(poller 内嵌)

```
evaluatePending 产生 needs_test 结论后 → runPendingTests():
  前置:全局 automationEnabled=1 且项目已配置 test_configs
  取 state='needs_test' 的行(每轮最多 2 条)
  逐条 runTest(manual=false)
```

手动触发:`POST /api/test/run {projectId, number}` —— 不受全局开关限制;
state='testing' 时返回 409"测试进行中"。

## 4. API

| 接口 | 说明 |
| --- | --- |
| GET /api/test/configs | 全部项目测试配置(JOIN 项目名) |
| POST /api/test/configs | 保存(UPSERT,单项目) |
| POST /api/test/run | 手动执行;返回流式输出或完成后结果 |
| GET /api/test/logs?projectId= | 测试历史(kind='test',复用 deployment/logs 加 kind 筛选) |

## 5. 前端

- **部署页**:项目分组头部加「测试配置」按钮 → 弹窗(服务器模式 local/ssh、
  IP/用户建议下拉、位置模板、**命令选项列表(可增删,首条为默认)**、AI 选择开关 + 提示词、超时)
- **自动化面板测试行**:「发起测试」按钮点亮;state=testing 显示"运行中…";
  完成显示 ✓通过/✗失败 + 「查看日志」(弹窗展示该次输出,复用部署日志样式)
- **部署历史**:增加类型列(部署/测试),测试行显示 PR 号
- PR 列表徽章:testing(蓝)/ test_passed(绿)/ test_failed(红)自动流转

## 6. 测试与验收

- 单测(mock spawn/fetch):
  - 命令序列组装(clone 条件/fetch/checkout SHA/命令)
  - local 与 ssh 模式;超时 kill;非零退出码失败
  - AI 选择命令:命中选项序号替换、越界/失败回退第一个选项
  - testing 状态互斥;自动触发受开关控制;每轮限量
- UI 测试:测试配置弹窗、发起测试流、面板状态流转、历史类型筛选
- 验收:配置真实测试服务器后,标记 needs_test 的 PR 在一轮内自动执行并回写状态

## 7. 明确不做(后续)

- 一个项目多台测试机并行
- 测试报告结构化解析(仅整段输出与退出码)
- 定时回归(每次 head 变化才触发)
