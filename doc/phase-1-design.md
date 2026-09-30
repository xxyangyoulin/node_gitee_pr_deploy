# 阶段 1 设计:PR 缓存 + 轮询 + Web 状态展示

> 交付目标:服务常驻运行,定时增量同步所有项目的开放 PR 到 SQLite;Web 列表基于缓存渲染,
> 响应即时;新 PR / head 变化被准确检测并打上状态。本阶段不引入 AI 与自动测试。

## 1. 数据库

### 新表 `pr_cache`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | INTEGER PK AUTOINCREMENT | |
| project_id | INTEGER NOT NULL | 关联 projects |
| number | INTEGER NOT NULL | Gitee PR 编号 |
| title | TEXT | |
| body | TEXT | PR 描述 |
| author | TEXT | 提交人 |
| head_ref / base_ref | TEXT | 分支 |
| head_sha | TEXT NOT NULL | **变更检测依据** |
| state | TEXT NOT NULL DEFAULT 'new' | 状态机:new / ai_reviewing / no_test_needed / needs_test / testing / test_passed / test_failed / merged / closed(阶段1只会出现 new / merged / closed) |
| status_note | TEXT | 状态备注(如"检测到新提交,待评估") |
| raw | TEXT | Gitee PR 原始 JSON(展示兜底) |
| gitee_created_at | TEXT | |
| gitee_updated_at | TEXT | Gitee 侧更新时间 |
| first_seen_at | TEXT NOT NULL | 首次入库时间 |
| last_seen_at | TEXT NOT NULL | 最近一次轮询见到的时间 |
| synced_at | TEXT NOT NULL | 最近同步时间 |

唯一索引:`(project_id, number)`。head_sha 变化时更新并置 state='new'、清空 status_note。

### 新表 `sync_state`(项目级轮询水位)

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| project_id | INTEGER PK | |
| last_sync_at | TEXT | 上次成功轮询时间 |
| last_error | TEXT | 最近一次失败原因(空=正常) |
| enabled | INTEGER DEFAULT 1 | 项目级轮询开关 |

### 新表 `settings` 扩展

- `pollIntervalSec`:轮询间隔,默认 180,最小 60(可配但防打爆)
- `automationEnabled`:全局开关,默认 0(关),阶段 2 起生效,阶段 1 仅存储

## 2. 轮询器(poller.ts)

### 流程

```
启动 → registerProjects(变更检测) → setInterval(pollIntervalSec)
每次 tick:
  1. 重入保护:上轮未完成则跳过(内存标志)
  2. 遍历 sync_state.enabled=1 的项目,每个项目独立 try/catch:
     a. GET pulls?state=all&sort=updated&direction=desc(带 updated_at 增量判断,
        全量拉取 50 条后内存过滤 gitee_updated_at > last_sync_at,足够覆盖默认间隔)
     b. upsert pr_cache:
        - 库中无 → INSERT,state='new',first_seen_at=now
        - 库中有且 head_sha 不同 → UPDATE + state='new'(新提交)
        - 库中有 → 仅刷新 title/body/raw/last_seen_at/gitee_updated_at
     c. 缓存中出现但 Gitee 已不存在的 open PR → 查详情确认 merged/closed 后置 state
     d. 成功:更新 last_sync_at,清 last_error;失败:记录 last_error,单个项目失败不影响其他
  3. 项目间并行(限量 3),整体 tick 串行
```

### 增量策略说明

Gitee pulls 接口无 since 参数,采用"拉 50 条 + 内存按 gitee_updated_at 过滤"。
间隔 ≥60s、单项目单请求,限流风险可控;请求 429/5xx 时指数退避(60s → 120s → 240s,连续
3 次失败暂停该项目直至下个 tick 重试)。

### 手动刷新兼容

现有 Web"刷新"按钮改为:触发一次即时 poll(单项目或全量)+ 返回缓存。
页面渲染全部来自 pr_cache,不再直接等待 Gitee 往返。

## 3. API 变更

| 接口 | 变更 |
| --- | --- |
| `GET /api/pulls?projectId=` | **新增**,读 pr_cache(按 gitee_updated_at 倒序),含 state/status_note |
| `POST /api/pulls/refresh` | **新增**,body 可选 projectId;触发即时轮询,完成后返回 |
| `GET /api/sync/status` | **新增**,返回各项目 last_sync_at / last_error / enabled |
| `POST /api/sync/toggle` | **新增**,项目级轮询开关 |
| `GET /api/settings` / `POST` | 扩展 pollIntervalSec / automationEnabled |
| 既有 `POST /api/gitee/pulls` | 保留(P 佈署页等直接调用场景),Web 列表不再使用 |

## 4. 前端变更

1. **PR 页数据源切换**:`loadPulls()` 改读 `GET /api/pulls`(缓存,毫秒级);
   "刷新"按钮调 `POST /api/pulls/refresh` 后重读缓存
2. **PR 列表加状态徽章**:阶段 1 实际出现 new / merged / closed(其余状态阶段 2/3 才会流转),
   徽章样式预留全部状态色:灰(待评估)、蓝(进行中)、绿(通过)、红(失败)、紫(已合并)
3. **项目加载失败可见**:复用现有警告条,数据源改为 `GET /api/sync/status`
4. **设置页新增"自动化"区块**:轮询间隔(分钟)、全局开关(预留)、各项目轮询开关列表

## 5. 测试与验收

- 单元级(mock Gitee,验证 poller 逻辑):
  - 新 PR 入库 state=new;head_sha 变化回到 new;仅更新元数据时状态不变
  - open→merged/closed 的状态落库
  - 单项目 API 失败不影响其他项目,last_error 记录
  - 重入保护(慢响应时不叠加重入)
- UI 级(Playwright,全 mock):
  - 列表渲染来自缓存接口;手动刷新触发 refresh 后列表更新
  - 状态徽章、sync 状态警告条、设置页轮询配置
- 验收标准:服务连续运行 1 小时,PR 缓存与 Gitee 实际开放列表一致;页面打开无 Gitee 直连等待

## 6. 明确不做(留给后续阶段)

- AI 评估触发与结果存储(阶段 2;本阶段 state 停留在 new)
- 测试执行(阶段 3)
- 服务端通知(阶段 4)
- Gitee webhook 推送替代轮询(远期备选,当前轮询够用)
