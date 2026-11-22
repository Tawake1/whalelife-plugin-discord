# WhaleLife Discord 文字插件 0.3.0

鲸鲸可以在 Discord 私信、服务器文字频道和讨论串中聊天。模型与人格来自 WhaleLife。首版默认关闭连接，允许一位指定用户发私信。服务器消息只在指定频道或讨论串里直接 @ Bot 并附上文字时触发。所有人共用同一频道的对话，各讨论串都有各自的历史。

## 安装

1. 准备 Node.js 24 和 WhaleLife v0.1.1，在网页控制台选好人格和模型，先确认网页聊天能回复。
2. 关闭 WhaleLife，在终端进入 WhaleLife 的 `plugins` 目录。首次安装时执行下面的命令，源码会放进 `plugins/discord/`，npm 根据锁文件安装运行依赖。

   ```sh
   git clone https://github.com/Tawake1/whalelife-plugin-discord.git discord
   cd discord
   npm ci --omit=dev --ignore-scripts
   ```

   也可以从仓库页面选择 **Code → Download ZIP**，解压后将含有 `plugin.yaml` 的文件夹命名为 `discord`，放入 WhaleLife 的 `plugins` 目录，再到该文件夹执行上述 npm 命令。已有独立安装包 `discord-0.3.0-install.zip` 的用户可直接解压安装，包中已带依赖。
3. 启动 WhaleLife，打开「插件管理 → Discord → 设置」。如果插件已被手动停用，先启用插件。
4. 在 [Discord Developer Portal](https://discord.com/developers/applications) 创建 Application，在 Bot 页取得 Bot Token。在 Installation 页为 Guild Install 选择 `bot` scope，使用安装链接将 Bot 加入测试服务器。使用有权安装应用的 Discord 账号操作。
5. 给 Bot 授予 **View Channel、Send Messages、Read Message History**。使用讨论串时另授予 **Send Messages in Threads**，并让 Bot 能看见和进入目标讨论串。首版使用普通 Guilds、Guild Messages、Direct Messages Gateway intents；私信和直接 @ Bot 的消息可读，无须开启 Message Content 特权意图。
6. 在 Discord「用户设置 → 高级」打开开发者模式，右键自己的用户头像、目标频道或讨论串复制 ID。进入 WhaleLife 的 Discord 设置，填写 Bot Token、选择人格，填写私信用户 ID、频道或讨论串 ID。勾选「连接 Discord」并保存，点「刷新状态」查看结果。

可只使用私信或只使用服务器频道。空白的名单关闭对应入口。频道名单按 ID 精确匹配，讨论串需要单独填 ID。Token 保存在本机插件的 `plugins/discord/data/config.json`，保存后设置页只显示是否已配置。本机资料和备份中可能含有该凭据。更换 Token 后在本页重新保存即可。

## 从 v0.1.0 或 v0.2.0 升级

关闭 WhaleLife，把 ZIP 解压到一个临时文件夹。打开解压后的 `discord` 文件夹，把里面的文件和目录复制到现有的 `plugins/discord/`，遇到同名文件选择覆盖。保留现有的 `data/` 文件夹（内有 Bot Token 和白名单），再启动 WhaleLife。

## 服务器频道命令

在已允许的频道或讨论串输入 `/whale status` 可查看回应状态。`/whale pause` 暂停接收这里的新聊天消息，`/whale resume` 恢复直接 @ 回应。更改状态需要 Discord 的「管理频道」权限。命令结果只有操作者可见。暂停按 Bot 和频道或讨论串保存，重启后继续有效。已经开始处理的消息可能仍会回复。

配置了允许频道后，Bot 登录时注册服务器可用的应用命令。若命令列表中找不到它，请检查该应用的安装授权包含 `applications.commands`（通常随 `bot` 一起授予），并确认你在该频道有「使用应用程序命令」权限。Discord 客户端同步可能稍有延迟。控制台的 Discord 设置页会显示注册失败提示；同名命令冲突需要管理者处理。

## 试聊和绑定

- **私信**　用指定账号给 Bot 发「你好」，默认建立独立私信会话。请确保账号能接收该 Bot 的私信，例如已在共同服务器允许私信。
- **网页续聊**　在 WhaleLife 网页对话页选中你要继续的独立网页会话，说一句容易记得的话。在 Discord 插件设置点「查看当前绑定」，核对私信用户、当前绑定和目标会话，再点「绑定此网页会话」。回 Discord 私信问起刚才的话题。绑定固定在确认时的会话，之后切换网页会话不影响私信。要解除共享，在同一处点「新建独立私信会话」，旧历史仍在原会话。
- **频道及讨论串**　在允许的位置发送「@鲸鲸 你想聊什么？」，由 Bot 在原处回复。每条消息保留发言人的 Discord ID 和当时称呼。公开频道及讨论串使用 WhaleLife 独立会话。共享人格设定、宿主全局事实和用户自行开启的其他共享记忆遵循宿主配置。
- **引用回复**　在 Discord 对一条文字消息点「回复」。私信中直接提问；在允许的频道或讨论串中，在自己的问题里直接 @鲸鲸。插件使用 Discord 随这条回复提供的同一位置的原文和作者，最多引用 1500 个 Unicode 码点。引用会作为本次来信的一部分进入会话历史。已删除、只有附件或平台未提供文字的引用会标明原文不可用；此时可以把想问的句子粘贴到消息里。
- **长回复**　每段最多 2000 个 UTF-16 单元。首段引用来信，回复中的文字不会触发用户、角色或全体提及。插件使用宿主回执处理网关重复消息，每段带稳定 nonce。部分已发或发送结果不明时停止后续分段，可在宿主日志中按消息 ID 核对完成状态。
- **范围**　首版提供纯文字聊天，Discord 渠道的模型工具权限固定为关闭。附件、语音、斜杠命令和主动发言留待后续版本。

## 常见情况

| 现象 | 可以检查 |
| --- | --- |
| 设置页一直显示正在连接或登录失败 | 刷新状态，检查 Bot Token、运行 WhaleLife 的机器能否连接 Discord Gateway 和 API，重新保存连接设置 |
| 私信收不到回复 | 检查名单中是否为你本人的用户 ID，以及是否已允许私信 |
| 频道能看到 Bot 却没回复 | 检查是否真正 @ 到 Bot、附有文字，以及频道或讨论串本身的 ID、可见性和发送权限 |
| 日志显示 generation_failed | 在宿主确认所选人格的模型能完成网页聊天 |
| 提示绑定已改变或会话忙 | 等待正在处理的消息完成，重新预览并核对目标后确认 |

## 源码与测试

`index.ts` 构造 Discord 客户端，`plugin.mjs` 管理其生命周期、宿主渠道和私信绑定，`transport.mjs` 处理事件过滤及投递，`settings.mjs` 提供控制台页面。

将源码和已执行 `npm ci` 的 [WhaleLife 宿主源码](https://github.com/iinukami/whalelife) 放在同级目录，宿主目录名为 `whalelife`。进入插件源码目录运行：

```sh
npm ci --ignore-scripts
npm test
```

可用 `WHALELIFE_TEST_HOST` 指定其他测试宿主目录。测试包含临时 WhaleLife 实例、模拟模型和本机 Discord Gateway/REST 服务。网络测试仅连接回环地址，使用合成凭据。

通过验证的宿主为 v0.1.1（afe281b）和 main（0080ba4），Node.js v24.22.3。已覆盖实际宿主加载、配置保存、会话绑定、并发与重启去重、两位发言人、讨论串隔离、长回复部分失败、频道命令权限、暂停状态持久化及真实 SDK 的断线恢复。真实 Discord 账号、服务器权限和投递需在安装后的测试服务器验证。
