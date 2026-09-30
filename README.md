# Gitee Release Console

浏览器端的 Gitee 发布控制台:聚合多个仓库项目的 PR、审查代码变更、一键合并与多服务器部署。

前端 Vue 3 + Vite + TypeScript,后端 Node.js(HTTP + SQLite)。Gitee API 调用与 SSH 部署均由后端代理执行,前端仅通过 HTTP API 交互。

## 功能

### PR 管理
- **跨项目聚合**:汇总所有已配置项目的开放 PR(项目徽章、分支着色、master/main 红色标注、创建时间倒序),支持按项目筛选
- **diff 浏览**:目录树侧栏(目录聚合增删统计、折叠)、文件名搜索、卡片展开/收起、完整文件查看、复制 diff;`.sql` 变更琥珀色重点标注,侧栏气泡提示"有 SQL 变动",点击定位
- **提交记录**:侧栏切换"文件 / 提交记录",点击提交在文件区查看该提交的变更,SHA 点击复制
- **PR 操作**:审查通过 / 测试通过 / 一键合并(两击确认防误触);创建 PR(项目下拉 + 默认分支预填)

### 一键流程
- **一键 master**:非 dock→dock 的 PR,自动 合并 → 创建 dock→master PR(沿用原标题)→ 合并
- **一键部署**:在上述流程后自动执行部署;dock→master 的 PR 则直接 合并 → 部署
- 进度弹窗在当前页展示分步状态(失败标红、可重试续跑)、部署目标(user@host、远程目录)与实时流式日志

### 多服务器部署
- 每个项目可配置多个部署目标(别名、主机、用户、远程目录、命令),支持上移/下移调整执行顺序
- 全部执行(顺序逐台、失败终止)/ 单台执行;服务器地址与 SSH 用户输入建议(复用已有配置)
- 流式部署日志,历史记录持久化(按项目筛选、点击回看)

### 设置
- PR 默认分支(head/base)与合并方式(merge / rebase / squash)
- 项目管理(编辑 / 删除,Token 留空保留原值)、应用版本与数据路径

## 快速开始

```bash
pnpm install
pnpm run start:web   # 构建前后端并启动,默认 http://127.0.0.1:18763
```

环境变量 `PORT` 可覆盖监听端口。

## 开发

```bash
pnpm run dev        # Vite 开发服务器(仅前端,API 需另行启动)
pnpm run check      # 类型检查 + 前后端构建
pnpm run test:ui    # Playwright 全量 UI 测试(自动启动 vite,全 mock,零真实 Gitee 调用)
```

测试依赖 Chromium:设置 `CHROME_PATH` 指向可执行文件,或 `pnpm exec playwright install chromium`。

## 数据存储

SQLite(`release-console.sqlite`,位于服务运行目录):

| 表 | 用途 |
| --- | --- |
| projects | 项目(名称、仓库、Token) |
| deploy_targets | 部署目标(别名、主机、用户、目录、命令、顺序) |
| deployment_logs | 部署历史(项目、目标、输出、成败、时间) |
| settings | 全局设置(默认分支、合并方式) |

首次启动会自动把旧版 `deployment_configs` 单目标配置迁移为一条默认部署目标,数据无损。
