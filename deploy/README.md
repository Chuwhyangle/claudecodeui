# deploy —— 本机 CloudCLI 实例的部署配置

这套文件记录 `172.16.10.52:3001` 上运行的 CloudCLI 是怎么配的，换机器时照此复现。

代码本身来自本仓库的构建产物：`npm run build` 之后把 `dist/`、`dist-server/`、`server/`、`shared/`
覆盖进 npm 安装目录 `~/cloudcli/node_modules/@yalehwang/cloudcli/`（systemd 的 `ExecStart` 直接指向
那里的 `dist-server/server/modules/cli/cli.js`）。

## 入库的文件

| 本仓库路径 | 安装到 | 说明 |
|---|---|---|
| `systemd/cloudcli.service` | `~/.config/systemd/user/cloudcli.service` | systemd user unit。绑 `172.16.10.52:3001`，`Restart=on-failure`，⛔ 不设任何 `ANTHROPIC_*`（凭据由 `~/.claude/settings.json` 提供） |
| `config/reply-suggestions.settings.json` | `~/.config/claudecodeui/reply-suggestions.settings.json` | 回复建议 chip：网关 `fjbigmodel`、模型 `deepseek-v4-flash-anthropic`、限额与超时。**只含密钥文件路径，不含密钥** |
| `config/server.settings.json` | `~/.config/claudecodeui/server.settings.json` | archguard 架构面板刷新用的 CLI 路径（本机 `/home/wenhao/tools/archguard/...`） |

配置文件是 mtime 热读的，改完不用重启服务。

## 不入库的东西

| 东西 | 位置 | 原因 |
|---|---|---|
| `gateway.key` | `~/.config/claudecodeui/gateway.key` | API 密钥（单行裸 key，600 权限）。`reply-suggestions.settings.json` 的 `apiKeyFile` 指向它。已在 `.gitignore` 中排除 |
| `auth.db` | `~/.cloudcli/auth.db` | 运行态数据库（会话、登录 token）。表结构由 `server/modules/database/migrations.ts` 启动时自动迁移，不需要随仓库分发 |
| `plugins/` | `~/.claude-code-ui/plugins/` | 第三方插件包（cloudcli-plugin-starter、cloudcli-plugin-terminal），各自独立发布 |

## 安装

```bash
mkdir -p ~/.config/claudecodeui ~/.config/systemd/user
cp deploy/config/*.json ~/.config/claudecodeui/
cp deploy/systemd/cloudcli.service ~/.config/systemd/user/

# 密钥单独放，权限 600
printf '%s\n' '<your-api-key>' > ~/.config/claudecodeui/gateway.key
chmod 600 ~/.config/claudecodeui/gateway.key

systemctl --user daemon-reload
systemctl --user enable --now cloudcli
systemctl --user status cloudcli      # 应在 172.16.10.52:3001 上 running
```

## 上线本仓库的代码

```bash
cd /home/wenhao/cloudcli-dev
npm run build
PKG=~/cloudcli/node_modules/@yalehwang/cloudcli
rsync -a --delete dist/        $PKG/dist/
rsync -a --delete dist-server/ $PKG/dist-server/
rsync -a          server/      $PKG/server/
rsync -a          shared/      $PKG/shared/
systemd-run --user --unit="cloudcli-restart-$(date +%s)" --collect \
  bash -c 'sleep 10; systemctl --user restart cloudcli'
```

⚠️ `npm i` 会擦掉以上覆盖，升级 npm 包后必须重新执行一遍。
