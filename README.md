# SimpleMD

SimpleMD 是 Windows 桌面 Markdown 阅读与编辑器。分栏模式下，文章目录、编辑器和实时预览同时显示。拖动分隔线可调整宽度，工具栏可切换到单栏视图。

## 使用

| 操作 | 快捷键 |
| --- | --- |
| 新建文档 | Ctrl+N |
| 打开文档 | Ctrl+O |
| 保存 / 另存为 | Ctrl+S / Ctrl+Shift+S |
| 关闭当前标签 | Ctrl+W |
| 显示 / 隐藏目录 | F12 |
| 编辑 / 分栏 / 预览 | Ctrl+1 / Ctrl+2 / Ctrl+3 |

可从资源管理器拖入 Markdown，或将路径作为命令行参数传入。启动时会按上次的标签顺序恢复退出前仍打开的文件，并选中上次的文件标签。打不开的文件会跳过并显示提示。主题、字体、字号、布局和会话一起保存在用户目录下的 `.SimpleMD/config.sqlite3`。

导出菜单提供独立 HTML、A4 PDF 和可编辑 DOCX。相对图片路径以源文档所在目录为基准。

## 开发与打包

本项目使用 Node.js、Rust MSVC 工具链、Visual Studio C++ 构建工具、Windows SDK 和 Microsoft Edge WebView2。在 Visual Studio 的 x64 开发者终端进入项目目录，并确保 `cargo` 位于 `PATH` 中。

~~~powershell
npm ci
npm run tauri -- dev
npm run tauri -- build --bundles nsis
~~~

安装程序位于 `src-tauri/target/release/bundle/nsis/`。Windows 构建静态链接 MSVC C 运行库与 SQLite，前端资源内嵌于可执行文件。界面渲染和 PDF 导出由 Windows WebView2 提供。
