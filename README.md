# Formd

面向 Web、Expo / React Native 和 VS Code 的协作 Markdown 工作空间。使用 **pnpm workspace + TypeScript** 组织 monorepo。

## 架构

Formd 采用 **TypeScript + pnpm monorepo，三个客户端共用一个服务端**。Web、移动端和 VS Code 各自负责界面与平台交互，共用文档 API 和协作客户端，不直接访问数据库。

- **HTTP**：Hono 提供文档列表、新建、重命名和删除。服务端校验请求，变更写入 PostgreSQL 后再返回成功。
- **实时协作**：客户端通过 `/sync/:id` 连接服务端，使用 Yjs 的 `Y.Text` 合并正文编辑。在线成员和光标通过同一个 WebSocket 广播，只存在内存中，不写数据库。
- **持久化**：服务端通过 `NoteStore` 保存文档元数据和 Yjs 状态。运行时使用 Drizzle ORM + PostgreSQL，自动化测试使用独立的内存存储。服务端启动时从数据库恢复文档，正文更新合并后异步写入。
- **部署边界**：当前每个数据库只运行一个服务端实例。PostgreSQL 负责持久化，不负责跨进程同步 Yjs 房间。

### 目录结构

```text
apps/
  web/src/                 Vite + React：编辑、预览、搜索与导出
  mobile/src/              Expo + React Native：路由和移动端编辑界面
  vscode/src/              扩展入口、文档视图、在线成员
  vscode/test/             VS Code 扩展宿主集成测试
  server/
    drizzle.config.ts      Drizzle Kit 数据库结构配置
    src/
      index.ts             读取环境配置、启动与关闭服务
      server.ts            组装 HTTP、协作和文档服务，协调关闭顺序
      http.ts              Hono 路由、跨域、请求校验与错误响应
      collaboration.ts     WebSocket 房间、心跳、在线成员与 Yjs 消息
      notes.ts             文档操作、Yjs 文档生命周期与持久化写入队列
      storage/
        index.ts           文档存储接口
        postgres.ts        Drizzle 存储实现
        schema.ts          PostgreSQL 文档表定义
    test/                  内存存储与浏览器测试服务入口
packages/
  core/src/                文档类型、输入校验、在线成员数据类型
  client/src/              跨平台 HTTP API、Yjs 会话和断线重连
  y-vscode/src/            VS Code 编辑器与 Y.Text 的增量绑定和撤销
tests/
  e2e/                     Playwright 浏览器端到端测试
```

依赖方向：客户端应用依赖 `packages/client`，共享客户端和服务端均依赖 `packages/core`；VS Code 额外使用 `packages/y-vscode`。共享包不反向依赖应用。新增协议与校验放在共享层，新增平台交互放在对应客户端，数据库读写留在服务端。单元测试及服务端集成测试与源码同目录。

服务端内部，HTTP 路由只调用文档服务，不直接读写数据库；协作层通过文档服务获取 Yjs 文档，并接收更新和删除通知。文档服务负责串行化持久化写入，存储层只负责读写。

## 快速开始

需要 Node.js 22.12+ 与 pnpm 12.10.1。依赖和锁文件统一在仓库根目录管理。

```bash
pnpm install --frozen-lockfile
export DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/formd'
pnpm run dev
```

- Web：<http://localhost:5173>
- API：<http://localhost:3001/api/health>
- PostgreSQL：使用 DBCode 中 `testdog` 连接的主机、端口和账号，将数据库名设为 `formd`。该库已建好 `public.notes`；在其他数据库初始化表可运行 `pnpm --filter @typo/server run db:push`。

在两个窗口中打开同一篇文档即可验证实时协作。正文编辑后立即发送 Yjs 更新，服务端合并待写入的更新并保存到 PostgreSQL，正常退出前会写入剩余更新。实时协作仍由单个服务端进程维护，不要同时启动多个服务端进程连接同一个 Formd 数据库。

## Web

由官方 `create-vite` React TypeScript 模板创建。

```bash
pnpm run dev:web
pnpm --filter @typo/web run build
```

可将 `apps/web/.env.example` 复制为 `.env.local` 配置 `VITE_API_URL`。支持新建、重命名、删除、标题搜索、编辑/分屏/预览、Markdown 格式快捷操作、分享当前文档链接、下载 `.md` 与窄屏侧栏。Markdown 原始 HTML 不执行。

## Expo / React Native

由官方 `create-expo-app` TypeScript 模板创建，目前使用 Expo SDK 58，原生 iOS/Android 使用 Expo Router 路由。共享 `@typo/client` 与 `@typo/core`，原生界面独立实现。

```bash
# 在一个终端启动后端，并允许局域网设备连接
HOST=0.0.0.0 pnpm run dev:server

# 将 apps/mobile/.env.example 复制为 apps/mobile/.env.local
# 把 EXPO_PUBLIC_API_URL 改成电脑的局域网地址，例如 http://192.168.1.100:3001
pnpm run dev:mobile
```

手机与电脑需在同一网络。iOS 模拟器可以使用 `http://localhost:3001`，Android 模拟器通常使用 `http://10.0.2.2:3001`。真机的 `localhost` 指向手机自身。

移动端支持列表、下拉刷新、创建、标题修改、正文协作、预览、系统分享导出和删除。Expo Crypto 提供 Yjs 所需的原生随机数；Metro 只为原生端适配 `lib0/webcrypto`。可按 [Expo SDK 文档](https://docs.expo.dev/versions/v58.0.0/) 设置匹配的运行环境。

```bash
# 验证 iOS/Android JavaScript 产物；这不生成原生安装包
cd apps/mobile
pnpm exec expo export --platform ios --platform android --output-dir dist
```

## VS Code 扩展

用 VS Code 打开仓库，按 F5 选择「运行 Formd VS Code 扩展」，会自动构建并启动 Extension Development Host。

活动栏点击 **Formd 羽毛图标** 即可打开「协作文档」视图。顶部支持新建、刷新和配置服务器；点击文档打开编辑器，右键可重命名/删除，行内按钮在 Web 打开。命令面板同时提供：

- `Formd: 打开协作文档`
- `Formd: 新建协作文档`
- `Formd: 删除协作文档`

设置 `typo.serverUrl` 指向与 Web 相同的后端，`typo.webUrl` 指向 Web 客户端地址。文档使用 `typo:` 虚拟文件系统，保留 VS Code 原生 Markdown 编辑体验；预览使用 VS Code 的「打开侧边预览」。

**正文逐次编辑实时同步，无需 Ctrl/Cmd+S 或 Auto Save**。实现位于 [`packages/y-vscode`](packages/y-vscode/README.md)，参考 y-monaco 的增量绑定方式，并处理 VS Code 编辑 API 的异步版本冲突。远端修改以局部 TextEdit 应用，多光标编辑按 offset 写入 Y.Text。Cmd/Ctrl+Z 和协作重做命令只撤销当前绑定的本地修改。保存仅确认缓冲区状态，不会用旧的全文快照覆盖合并结果。支持远端成员/光标/选区显示，以及当前文档内的成员定位与跟随。

```bash
pnpm run package:vscode
# 得到 apps/vscode/typo-vscode-0.3.0.vsix
code --install-extension apps/vscode/typo-vscode-0.3.0.vsix
```

## 在线成员与光标

Web 顶部显示在线成员头像与人数，点击可展开成员列表，编辑自己的显示名称和光标颜色；编辑区显示彩色远端光标、姓名标签和选区。位置使用 Yjs 相对位置，能随并发编辑移动，覆盖层同步文本换行与滚动。自己的选区也会在远端插入后保持锚定。

VS Code 的 Formd 活动栏新增「在线成员」，显示当前文档的成员、客户端和所在行列。点击成员定位光标，行内图钉开始跟随，顶部停止按钮结束跟随；切换文档或使用键盘/鼠标移动选区也会结束跟随。跟随只滚动定位当前文档的成员光标，不自动跨文件切换。编辑器中显示成员颜色、姓名和选区，概览标尺标记位置。参考 [Live Share 的协作交互](https://learn.microsoft.com/en-us/visualstudio/liveshare/use/coedit-follow-focus-visual-studio-code)。

扩展设置 `typo.displayName` 修改名称，`typo.cursorColor` 设置十六进制颜色，留空使用自动分配的访客资料。Web 资料保存在当前浏览器，VS Code 默认访客资料保存在扩展状态中。当前没有登录身份，列表按连接会话统计，同一个人打开多个窗口会显示多个会话，展示的是当前文档的在线状态。

协议使用独立的 `presence` 消息传递 `{ user, selection }`，服务端为每条连接分配身份；选区端点编码为 Yjs RelativePosition。状态仅保存在内存中，不写入文档或修改文档更新时间。正常离开立即移除，异常断网由 WebSocket 心跳在约 30 秒内清理；重连重新注册，客户端断线时先清空远端成员。设计参考 [Yjs Awareness 与 Presence](https://docs.yjs.dev/getting-started/adding-awareness)，并使用服务端管理的文档级成员快照。当前只广播主选区；移动端尚未提供成员/光标界面。

升级时请同时重启后端和 Web，并安装 0.3.0 扩展，保证两端使用支持 presence 的协议版本。

## 校验

```bash
pnpm run typecheck
pnpm run build
pnpm test
pnpm --filter @typo/mobile run lint
pnpm --filter @typo/web run lint

# 真实 VS Code 扩展宿主 + Chrome/Chromium 联测
pnpm run test:vscode

# 首次安装 Playwright 浏览器
pnpm exec playwright install chromium
pnpm run test:e2e
# 如果本机已有 Chrome，可使用 PLAYWRIGHT_CHANNEL=chrome pnpm run test:e2e
```

集成测试使用临时数据目录与真实 HTTP/WebSocket，覆盖文档 CRUD、两客户端并发修改收敛、断线编辑重连、服务重启恢复、删除通知和输入校验。y-vscode 绑定测试还覆盖异步编辑期间输入、相同字符并发插入、多光标 UTF-16 offset、独立撤销/重做和绑定释放。`pnpm run test:vscode` 使用独立临时用户目录启动 VS Code 扩展宿主及真实浏览器，验证侧栏、未保存输入实时同步、并发合并、双端成员与选区、相对位置、成员跟随/停止、离开清理、保存和重命名后的稳定绑定；默认下载测试 VS Code，可设置 `VSCODE_EXECUTABLE_PATH` 使用已有可执行文件，`PLAYWRIGHT_CHANNEL=chrome` 使用已有 Chrome。

浏览器测试使用 3002/5174 端口与 `.tmp/e2e-data`，覆盖双窗口编辑、预览、重命名、导出、窄屏侧栏和删除通知。

`pnpm run build` 构建 Web、服务端和 VS Code 扩展；Expo 的移动端导出单独运行。移动端 JavaScript 打包通过不代表已经验证真机行为或生成签名安装包。

## API 与配置

| 接口                    | 用途                         |
| ----------------------- | ---------------------------- |
| `GET /api/health`       | 健康检查                     |
| `GET /api/notes`        | 列出文档元数据               |
| `POST /api/notes`       | 创建 `{ title, content }`    |
| `PATCH /api/notes/:id`  | 修改 `{ title }`             |
| `DELETE /api/notes/:id` | 删除文档并通知已连接客户端   |
| `WS /sync/:id`          | Base64 编码的 Yjs 二进制更新 |

后端从进程环境读取 `PORT`（3001）、`HOST`（127.0.0.1）、`DATABASE_URL`（PostgreSQL 连接串）、`ALLOWED_ORIGINS`（逗号分隔）。服务端命令从工作目录加载 `.env`（可参考配置示例），shell 中已设置的变量优先。不同 Web 地址需加入 `ALLOWED_ORIGINS`，例如局域网 Web 开发地址。生产环境前端和服务端需使用 HTTPS/WSS。

## 当前边界

这是可运行的单实例开发 MVP。暂未实现登录、团队与文档权限、只读分享、版本历史、附件上传、生产数据库与多实例扩展。当前分享链接用于定位文档，不是权限控制；连接到此服务的客户端可以访问全部文档。

正文断线修改保留在当前客户端会话内存中，重连后自动合并；尚未同步时关闭页面、切换文档或退出应用会丢失该部分修改，应等待连接恢复或先导出。标题使用 REST 保存，更新后由 Web 列表每 5 秒刷新，移动端可下拉刷新。

依赖审计仍有 Expo 指纹工具及 VSIX 打包工具链的 moderate 告警。已将移动端 Markdown 解析器覆盖为修复版 `markdown-it >=14.3.3`，避免旧渲染库携带的高风险解析器；不要使用 `强制自动修复` 降级 Expo SDK。

后续可在保留共享客户端协议的前提下加入身份鉴权与授权，再扩展版本记录和客户端持久离线缓存。
