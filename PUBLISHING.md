# 发布清单

从「本机能用」到「别人能装」，中间隔的不是技术，是这几件小事。按顺序做，大约 40 分钟。

---

## 先说清楚三件事，再决定要不要发

**1. 这个插件不是装完就能用**

它依赖 LiteLoaderQQNT，而 LiteLoaderQQNT 本身要绕过 QQ 的文件校验（README 第二节写了）。也就是说：每一个用户都要自己动手改一次 QQ 安装目录。

这条不能藏着，写清楚反而是保护你自己——出问题的人至少知道自己动了什么。

**2. 它会把你聊天记录的正文存成明文**

索引文件是 `records.jsonl`，一行一条卡片，包含发送人、时间、正文。就在用户自己的硬盘上，不上传任何服务器。

但请把这句话写进 README 显眼处，并且**在设置页加一句提醒**。用户有权知道自己的聊天被完整复制了一份。

**3. 抓取方式踩在协议的灰区**

调的是 QQ 自己的内部接口。没有破解、没有伪造登录，但也不在官方开放范围内。公开发布时，README 里那句「请只用于管理你自己的聊天记录」不是免责声明，是真的使用边界。

---

## 第 1 步：填掉两处占位（5 分钟）

现在代码里只有两个地方是假的，必须改：

| 文件 | 占位 | 改成 |
|---|---|---|
| `manifest.json` | `TODO_YOUR_NAME` / `TODO_YOUR_GITHUB` | 你的名字 / GitHub 用户名 |
| `manifest.json` | `repo: TODO_YOUR_GITHUB/LiteLoaderQQNT-Plugin-ForwardSearch` | 你的仓库路径 |
| `LICENSE` | `Copyright (c) 2026 TODO_YOUR_NAME` | 你的名字 |

仓库名建议就叫 `LiteLoaderQQNT-Plugin-ForwardSearch`——LiteLoader 社区的习惯命名，别人搜得到。

改完之后，`.github/workflows/release.yml` 里有一道检查：只要还留着 `TODO_YOUR`，打包会直接失败。这样你就不会误发一个作者是占位符的版本。

---

## 第 2 步：本地先打一次包（5 分钟）

别等 CI，先自己确认 zip 结构是对的。

```bash
cd forward-search
mkdir -p dist/forward-search
cp -r manifest.json LICENSE README.md CHANGELOG.md src assets dist/forward-search/
cd dist && zip -r forward-search.zip forward-search
```

解压 `forward-search.zip`，**第一层就应该是 `forward-search/`，里面有 `manifest.json`**。

如果解压出来是 `forward-search/forward-search/...` 这种双层结构，用户装上去插件不会加载——这是上架被退回最常见的原因，没有之一。

本地验证方式：把解压出来的 `forward-search` 文件夹丢进 `LiteLoaderQQNT/plugins/`，重启 QQ，看主面板右下角有没有那个圆形按钮。

---

## 第 3 步：建仓库、推上去（10 分钟）

```bash
git init
git add .
git commit -m "feat: 合并转发搜索 v1.0.0"
git branch -M main
git remote add origin git@github.com:<你的用户名>/LiteLoaderQQNT-Plugin-ForwardSearch.git
git push -u origin main
```

**推之前务必确认 `.gitignore` 生效**。绝对不能进仓库的东西：

- `QQNTPatcher.exe`、`dbghelp.dll`、`ll.zip` —— 这些是绕过校验的工具，不是插件的一部分，也不该由你分发
- `records.jsonl`、`config.json`、`debug.log` —— 里面有你的聊天内容和机器路径
- `screenshots/` 里带真实联系人的截图（见第 6 步）
- 任何 `H:\`、`C:\Users\...` 这类本机绝对路径

推完在 GitHub 上肉眼过一遍文件列表，比 `.gitignore` 更可信。

---

## 第 4 步：打 tag、等 CI 出包（5 分钟）

```bash
git tag 1.0.0
git push origin 1.0.0
```

CI 会做三件事：校验 tag 和 `manifest.json` 的 `version` 一致、校验没有 TODO 占位、打包并挂到 Release。

去 Actions 页面看绿灯，然后到 Releases 里确认 `forward-search.zip` 能下载、能解开、结构对。

**这一步的意义**：`manifest.json` 里 `repository.release` 指向的就是这个 zip。没有它，插件市场只能下源码，用户在 LiteLoader 里点「更新」会失败。

---

## 第 5 步：上架插件市场（10 分钟）

流程是给 LiteLoader 的插件列表仓库提 PR：

1. Fork [LiteLoaderQQNT/LiteLoaderQQNT-Plugin-List](https://github.com/LiteLoaderQQNT/LiteLoaderQQNT-Plugin-List)（具体仓库名以官方文档当前写法为准，进组织主页看一眼最稳）
2. 按仓库 README 的格式，在插件清单里加一条你的插件（通常是 `slug` + `repo`，别的字段由 `manifest.json` 提供）
3. 提 PR，标题写清楚「新增插件：合并转发搜索」
4. 等维护者合并

维护者大概率会看这几项，提前自查：

- zip 结构对不对（第 2 步已经验证过）
- `manifest.json` 字段齐全、`version` 合法（`1.0.0` 这种三段式）
- 仓库里有 README、有 LICENSE
- 插件真的能装、能卸载、不崩 QQ

被退回来最常见的理由是「描述太笼统」和「没有图标」。你的图标在 `assets/icon.png`，已经挂进 manifest 了。

---

## 第 6 步：换掉现在的截图（重要，容易忽略）

`../screenshots/` 里那几张真机图**不能直接发**：

- 左侧会话列表里有真实群名、好友备注
- 顶栏有你的 QQ 昵称
- 图里能看出你的屏幕分辨率和窗口布局

三种处理方式，从省事到讲究：

1. 用马赛克糊掉所有名字（最快，但看着不专业）
2. 用一个小号 + 几个假群重新截（推荐，能控制展示效果）
3. 只放弹窗局部，避开会话列表（最简单，也够用）

另外建议补一张**动图**：唤起 → 输入关键词 → 结果出现 → 点开全文。GIF 比十张静图管用，商店列表里也更容易被点。

---

## 第 7 步：发出去之后（长期）

- **开 Issues**：至少给一个模板，问清 QQ 版本、LiteLoader 版本、`debug.log` 最后几行
- **别承诺兼容**：QQ 每次更新都可能让内部接口失效，README 里写「接口失效时基础搜索仍可用」，比写「持续维护」实在
- **版本号要老实**：接口挂了就发 `1.0.1` 说明降级，别硬撑 `1.1.0 新增功能`

---

## 一句话总结

代码已经写完了，发布要补的其实只有四样：**真名字、真图标（已有）、正确的 zip 结构、一张不漏隐私的截图**。剩下全是点鼠标的活。

`manifest.json` 里那两个 `TODO_YOUR` 一填，就可以走了。
