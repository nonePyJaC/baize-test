# 白泽 BAIZE

基于 Tauri 2、React、TypeScript 和 Rust 的本地测试工作台，支持需求资料、XMind 用例评审、测试执行与证据、报告、知识候选审核、AI 会话及接口调试。

## 使用

安装后选择一个空目录并初始化工作区，再自行添加平台和需求。新工作区没有预置业务平台或业务资料。

- 模型服务、外部系统连接、访问令牌由使用者在设置中自行配置，仅存本机。
- 外部系统未配置时仍可使用本地工作流。当前已实现云效适配器和用于开发验证的内存适配器，其他系统通过连接与能力接口扩展。
- 接口调试按项目管理环境、鉴权、Headers 和前后置脚本；支持 Postman、OpenAPI、cURL 及兼容报文导入。需要先填写目标环境地址与鉴权值。
- AI 可以根据当前接口用例生成可审阅的请求和断言草稿，也可复制提示词交给其他 Agent。加入草稿后由人发送请求。
- 前后置脚本支持常用同步 `pm.*` API 和 CryptoJS，未实现完整 Postman Runtime、脚本内异步网络请求、multipart 文件上传或 Collection Runner。
- 用例修改、删除原因和执行证据供复盘与定稿使用；外部发布先预览再确认，需求阶段由人推进。

安装程序不携带工作区、个人设置或历史记录。在已使用过白泽的同一账户下重新安装，会继续读取该账户原有的本机配置。

## 开发与构建

需要 Node.js 20 或更高版本、Rust stable，以及 Tauri 对应平台的开发环境。Windows 需要 MSVC C++ 构建工具与 WebView2，macOS 需要 Xcode 命令行工具。品牌素材已包含，构建无需重新生成图标。

```sh
npm ci
npm run dev
# 启动桌面开发模式
npm run tauri dev
```

生成 Windows 安装包：

```sh
npm run tauri build -- --bundles nsis,msi
```

生成 macOS 应用和镜像（须在 macOS 上运行）：

```sh
npm run tauri build -- --bundles app,dmg
```

产物位于 `src-tauri/target/release/bundle/`。Windows 构建前退出正在运行的客户端。发布签名需要维护者自己的证书，本项目不提供证书或密钥。

## 验证

```sh
npm run build
npm run test:case-revision
npm run test:session-review
npm run test:integrations
npm run test:api-debug
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

默认测试使用合成数据或本地回环服务器；外部网络测试标记为 ignored，不默认执行。可选的本地接口样本不随源码提供。

## 目录

- `src/`：界面、工作流投影与接口脚本运行时。
- `src-tauri/src/`：工作区文件操作、会话运行时、外部系统适配器和原生 HTTP。
- `protocols/`：工作区、需求、用例、执行与知识等通用数据协议。
- `tools/`：验证脚本、XMind 适配和品牌素材生成工具。
- `.github/workflows/`：手动触发的双平台构建流程，不自动创建发布或提交代码。

Python 工具不是运行客户端的必需条件；重新生成品牌图片时另需 Pillow。

## 发布范围

源码仅包含程序、协议、品牌素材和合成测试，不包含工作资料、开发派发文档、日志、截图、工作区、连接配置、令牌、证书或构建缓存。公开前尚需维护者指定项目许可证；第三方依赖许可清单与原始通知单独保留。
