[English](./README.md) | [中文](./README.zh-CN.md)

# pot-app-tts-plugin-edge

一个自包含的 [Pot](https://github.com/pot-app/pot-desktop) 语音合成插件，通过
微软 Edge 浏览器**朗读**功能所用的同一服务朗读文本。

不需要 Python，不需要本地服务，不需要 Azure 账号，不需要 API key，不需要常驻
辅助程序。装上 `.potext` 就能用。

> **隐私说明：** 文本会发送到微软的服务器进行合成。这是在线语音合成，不是本地
> 合成。

## 状态

可用。音色、语速、音调、音量均可配置，并会按翻译的目标语言自动选择合适的音色。

## 平台支持

| 平台 | 是否可用 |
|---|---|
| Windows (WebView2) | **可用** |
| macOS (WKWebView) | 不可用 |
| Linux (WebKitGTK) | 不可用 |

这是硬性限制，不是 bug。该服务要求握手时携带标识为 Microsoft Edge 的
`User-Agent`（主版本号 ≥ 132），而**网页无法为 WebSocket 握手设置
`User-Agent`** —— 插件只能继承宿主 WebView 发出去的那一个。Tauri 在 Windows 上
用 WebView2（本身就是 Edge，所以能通过），在其他平台用 WebKit（不通过）。详见
`docs/DESIGN.md` §6。

## 安装

从[最新 release](https://github.com/edwyj/pot-app-tts-plugin-edge/releases/latest)
下载 `plugin.com.pot-app.edge_read_aloud_tts.potext`，然后把它拖到 Pot 窗口上，
或从 Pot 的插件设置里导入。

安装后，在 **设置 → 服务 → 语音合成** 中启用它，之后就能对任意翻译结果点朗读
按钮。

> **未进入官方插件列表。** `pot-app` 组织（含 `pot-desktop`、各插件模板和
> `pot-app-plugin-list`）已在 GitHub 上归档，而归档仓库无法接收 PR 或新 issue。
> 本插件改为从本仓库的 release 分发。Pot 本身仍可正常使用，两种方式安装插件的
> 步骤完全一样。

若要从源码构建，见下方[构建](#构建)。

## 配置

控件出现在同一个 **设置 → 服务 → 语音合成** 面板中。

| 控件 | 作用 |
|---|---|
| 音色 | 25 个精选音色之一。默认的「自动（按语言）」会按翻译的目标语言挑选。 |
| 自定义音色 | 音色短名，例如 `de-DE-KatjaNeural`。填写后会**覆盖**上方的下拉选择。 |
| 语速 / 音调 / 音量 | 各五档。 |

自定义输入框是使用其余音色的出口：该服务提供 **142 个地区共 322 个音色**，远超
一个不可搜索的下拉框所能容纳。音色名必须形如
`<语言>-<地区>-<名称>Neural`。四个带 script 子标签的因纽特语音色
（如 `iu-Latn-CA-SiqiniqNeural`）会被拒绝 —— 服务端期望的长名未知，贸然发送
会失败且没有任何诊断信息。

**选项 key 是永久性的。** Pot 存的是 key 而不是标签，已存储的 key 在新版中不
存在时会在界面上渲染成 `undefined`。发布后这些 key 都不能改名。详见
`docs/DESIGN.md` §10。

## 构建

```powershell
./build.ps1          # -> dist/<插件id>.potext
```

`build.ps1` 与 `.github/workflows/build.yml` 对应：两者打包同样三个文件，因此
两个产物的**内容**一致，但**字节并不相同** —— 本地用 `Compress-Archive`，CI 用
`vimtor/action-zip`，两者的压缩实现和存储的时间戳都不同。要比就比解压后的内容，
不要比文件 hash。

## 开发笔记

- `main.js` 被 Pot 以**经典脚本**方式 `eval`
  （`src/utils/invoke_plugin.js:35`）。它不能使用 `import`/`export`，且必须让
  `tts` 成为最后一个表达式 —— Pot 会在源码末尾拼接裸标识符 `tts` 以取得其
  求值结果。
- Edge 协议集中在 `main.js` 顶部一个带标记的区块里。微软更新服务时，预期需要
  改动的只有这一块。
- 用户选项在 `info.json` 的 `needs` 中声明，在 `main.js` 的 "User options"
  区块中解析。其中两条规则是关键：每个 `select` 的第一项必须是插件的真实默认
  值，且选项 key 永远不能改名。详见 `docs/DESIGN.md` §10.1。
- `docs/DESIGN.md` 记录了插件契约、Pot 运行时、Edge 朗读协议，以及每条结论是
  如何验证的。

## 许可证

MIT。本插件是对 Edge 朗读**线协议**的独立 JavaScript 重写；未复制
`rany2/edge-tts`（LGPLv3）的任何代码。详见 `docs/DESIGN.md` §8。
