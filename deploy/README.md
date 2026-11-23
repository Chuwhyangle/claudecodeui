# deploy —— Cloudpit 服务的部署资产

这套文件记录「把本仓库构建出来的 Cloudpit 跑成一台常驻服务」需要的东西：
一份 systemd user unit、一份环境变量样例，以及桌面提醒脚本的安装说明
（脚本本体在 `scripts/windows-notify/`）。

代码本身来自本仓库的构建产物：`npm run build` 之后把 `dist/`、`dist-server/`、
`server/`、`shared/` 覆盖进 npm 安装目录，unit 的 `ExecStart` 直接指向那里的
`dist-server/server/modules/cli/cli.js start`。

## 入库的文件

| 本仓库路径 | 装到 | 说明 |
|---|---|---|
| `systemd/cloudpit.service` | `~/.config/systemd/user/cloudpit.service` | systemd **user** unit。路径一律用 systemd 的 `%h`（安装者家目录），不写死某个人的路径；绑定地址 / 端口 / 提醒命令全部走环境变量文件 |
| `config/cloudpit.env.example` | `~/.config/cloudpit/cloudpit.env` | 站点相关配置：`HOST`、`SERVER_PORT`、可选的 `CLAUDE_CLI_PATH`，以及 `CLOUDPIT_DESKTOP_NOTIFY_CMD`（桌面提醒通道，留空=关闭） |

## 不入库的东西

| 东西 | 位置 | 原因 |
|---|---|---|
| 真实的 `cloudpit.env` | `~/.config/cloudpit/cloudpit.env` | 含部署特有的地址/命令，因人而异 |
| 模型凭据 | `~/.claude/settings.json`、`~/.codex/` | Cloudpit 是**寄生**在 CLI 上的：凭据由 Claude Code / Codex 自己的配置文件提供，unit 里刻意不设任何 `ANTHROPIC_*` |
| 运行态数据库 | `~/.cloudpit/auth.db`（或 `DATABASE_PATH`） | 表结构由 `server/modules/database/migrations.ts` 启动时自动迁移，不需要随仓库分发 |

## 安装

```bash
mkdir -p ~/.config/systemd/user ~/.config/cloudpit
cp deploy/systemd/cloudpit.service ~/.config/systemd/user/
cp deploy/config/cloudpit.env.example ~/.config/cloudpit/cloudpit.env
$EDITOR ~/.config/cloudpit/cloudpit.env      # 至少确认 HOST / SERVER_PORT

systemctl --user daemon-reload
systemctl --user enable --now cloudpit
systemctl --user status cloudpit
```

不想用 systemd 时，环境变量文件同样可以 `set -a; . ~/.config/cloudpit/cloudpit.env; set +a`
之后前台跑 `node .../dist-server/server/modules/cli/cli.js start`。

## 上线本仓库的代码

```bash
cd <repo>
npm run build
PKG=~/cloudpit/node_modules/@yalehwang/cloudpit
rsync -a --delete dist/        "$PKG/dist/"
rsync -a --delete dist-server/ "$PKG/dist-server/"
rsync -a          server/      "$PKG/server/"
rsync -a          shared/      "$PKG/shared/"
systemctl --user restart cloudpit
```

⚠️ `npm i` 会擦掉以上覆盖，升级 npm 包后必须重新执行一遍。

## 桌面提醒

页面关掉之后，「等待你回话」的会话需要一个浏览器之外的通道。开启方法：

1. 在一台 Windows 机器上按 [`scripts/windows-notify/README.md`](../scripts/windows-notify/README.md)
   装好脚本并注册计划任务（一次性）；
2. 在 `~/.config/cloudpit/cloudpit.env` 里取消 `CLOUDPIT_DESKTOP_NOTIFY_CMD` 的注释并改成自己的路径；
3. `systemctl --user restart cloudpit`，日志里不再打印
   `Awaiting-reply desktop alerts are off (...)` 即表示通道已接上。

旧名字 `CLOUDCLI_DESKTOP_NOTIFY_CMD` 仍然兼容，所以既有部署不必同步改 unit。
