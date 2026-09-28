# Gitee Release Console

浏览器应用，用于在一个网页中查看多个 Gitee 项目的 PR、审核代码变更、执行合并和后续部署。

前端使用 Vue 3 + Vite + TypeScript，后端使用 Node.js HTTP 服务和 SQLite。Gitee API、SSH 部署和令牌数据只在后端处理，前端通过 HTTP API 访问。服务固定监听 `18763` 端口。

## 开发

```bash
pnpm install
pnpm run check
```

启动 Web 服务：

```bash
pnpm run start:web
```

然后在浏览器打开 `http://127.0.0.1:18763`。

项目和部署配置保存在服务目录的 SQLite 文件中。创建 PR、合并 PR 和 SSH 部署都必须在网页中主动点击，测试时不要对真实仓库执行这些操作。
