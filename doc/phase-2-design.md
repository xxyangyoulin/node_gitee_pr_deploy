# 阶段 2 设计:AI 评估管线

> 前置:阶段 1 已实施(pr_cache 状态机 / poller 轮询 / 缓存读接口)
> 交付目标:新 PR(或 head 变化)自动调用大模型判断"该变更是否需要运行测试",
> 结论与理由入库并在 Web 展示;同 SHA 不重复评估;全程可关闭、可追溯。

## 1. 配置(settings 扩展)

| 键 | 默认 | 说明 |
| --- | --- | --- |
| aiBaseUrl | `https://api.deepseek.com/v1`(示例) | OpenAI 兼容 base_url |
| aiApiKey | 空 | 未配置时评估管线整体跳过(状态停留 new) |
| aiModel | `deepseek-chat` | 模型名 |
| aiPrompt | 内置默认模板 | 提示词,支持变量插值 |
| automationEnabled | 0 | **全局总开关**,阶段 2 起生效 |

提示词变量:`{{title}}`、`{{body}}`、`{{files}}`(文件清单+增删统计)、`{{diff}}`(截断后的关键 diff)。

默认模板(要求 JSON 输出):

```
你是代码评审助手。根据以下 PR 信息判断该变更是否需要运行自动化测试。
规则:.sql 文件变更一律需要测试;仅文档/注释/格式化改动通常不需要。
PR 标题:{{title}}
PR 描述:{{body}}
变更文件:
{{files}}
关键 diff:
{{diff}}
仅输出 JSON:{"needs_test": true|false, "reason": "一句话理由", "risk_level": "low"|"medium"|"high"}
```

## 2. 评估触发(poller 内嵌)

```
pollAll 每轮结束 → evaluatePending():
  1. 前置:automationEnabled=1 且 aiApiKey 非空,否则返回
  2. 取 state='new' 的行(按 first_seen_at 升序,每轮最多 5 条,防突发洪峰)
  3. 逐条:
     a. 拉取 PR 文件列表(Gitee pulls/{n}/files,结果不入库,评估用完即弃)
     b. 硬规则:任一 .sql 文件 → needs_test=true,reason="包含 SQL 变更",不调用模型
     c. 构造输入(见 §3)调用模型
     d. 解析 JSON:失败重试 1 次,仍失败 → 降级 needs_test=true,reason="AI 评估失败,默认需要测试"
     e. 更新 pr_cache:state → needs_test / no_test_needed,status_note=reason,
        新增列 ai_result(JSON 原文)、ai_evaluated_at、ai_skip(硬规则标记,可选)
  4. 评估期间置 state='ai_reviewing'(进入即写,防止下轮重复捞取)
```

## 3. 输入构造与截断

- `{{files}}`:`path (+N -M)` 每行一条,最多 60 行,超出加 `… 共 X 个文件`
- `{{diff}}`:取前 6 个文件(优先 .sql/.ts/.js/.py 等代码文件,文档靠后),每个文件 patch 截前 80 行;
  总长度上限 12000 字符,超出尾部标注 `…(已截断)`
- `{{body}}` 截前 500 字符

## 4. AI 调用(server/ai.ts)

- OpenAI 兼容 `POST {aiBaseUrl}/chat/completions`,body:`{ model, messages, response_format: { type: 'json_object' }, temperature: 0 }`
- 超时 30s(AbortController);失败/超时计入 request_logs 复用(gitee logger 之外单独简单 console + 失败入 status_note,不新增表)
- 同 SHA 去重:评估前检查该 (project_id, number, head_sha) 是否已有 ai_result,有则跳过

## 5. 数据库变更

`pr_cache` 新增列(ALTER TABLE,启动迁移):

| 列 | 说明 |
| --- | --- |
| ai_result | TEXT,模型原始 JSON(硬规则时为人工构造的同结构 JSON) |
| ai_evaluated_at | TEXT,评估完成时间 |

状态机扩展生效:`new → ai_reviewing → needs_test / no_test_needed`。

## 6. API 与前端

- 无新增接口:`GET /api/pulls` 返回行天然携带新 state/status_note/ai_result
- 前端 PR 列表:状态徽章已支持全部配色,自动流转(待评估灰 / 待测试橙 / 无需测试绿)
- PR 选中后:标题栏下方或描述面板上方展示 AI 结论条(风险级别 + 理由,浅色背景)
- 设置页"自动化"区块补:模型 base_url / api_key(password)/ 模型名 / 提示词(textarea)+
  "测试连接"按钮(发一条 ping 请求验证配置)

## 7. 测试与验收

- 单测(mock fetch,不触网):
  - 硬规则:.sql → needs_test,不调模型(fetch 未被调用)
  - 模型 JSON 解析、非法输出重试后降级 needs_test
  - 同 SHA 不重复评估;ai_reviewing 期间不被重复捞取
  - automationEnabled=0 或无 key 时完全不触发
  - 输入截断:超长文件清单/diff 被正确截断
- UI 测试(mock):状态徽章流转展示、AI 结论条、设置页配置表单与测试连接
- 验收:配置真实 key 后,新提交 PR 在 1 个轮询周期 + 评估时长内出现结论;连续运行无重复计费

## 8. 明确不做(留给阶段 3+)

- 测试的自动执行(needs_test 之后的流转)
- 项目级提示词覆盖(先全局,有需要再加)
- token 用量统计与成本报表(审计在阶段 4 一并考虑)
