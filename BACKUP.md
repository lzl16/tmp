# 牌局数据备份

代码备份与牌局数据备份分别运行。网站数据库仍是原始数据来源。

## 流程

1. `finishGame` 在数据库事务中保存结束状态、分数与结算统计。
2. 事务成功后，服务端以最多 1 秒的等待时间触发 `backup-records.yml`。结算失败时不触发，备份网络异常不回滚已经成功的结算。
3. GitHub Actions 只读获取全部新版用户及牌局，重新计算每场名次和玩家历史统计，写入 `backups/database.json`，然后提交到备份仓库的 `main` 分支。
4. 每小时第 17 分钟有一次补备份检查，覆盖触发超时、断网或进程中断的情况。GitHub 调度可能延迟，不保证即时完成。

流程在云端运行，不要求本机电脑或 Codex 开着。同一仓库的备份串行执行；记录未变化时不产生仅更新时间的提交。每次有变化的 Git 提交保留上一版快照。

## 备份内容

`backups/database.json` 包含：

- `users`：玩家编号、昵称、创建时间。
- `games`：全部新版牌局，包括进行中牌局，包含每局正常得分或错牌结果、错牌玩家、主庄、副庄、升级与轮庄、等级、时间和名次统计。
- `userStatistics`：各玩家主庄/副庄/闲家总局数、各角色加权均分、平均名次和历史明细。同时包含本人错牌局数、主庄/副庄/闲家各自的平均升级数、平均被升级数及计算所需总数。错牌局只计累计升级与本人错牌次数，不计角色局数及均值。
- `source`、`schemaVersion`、`exportedAt`、`dataHash`：来源、格式版本（当前为 2）、导出时间、内容校验值。

采用字段白名单，不包含管理密钥、密钥哈希、GitHub 凭据或腾讯云管理凭据。未导入的旧版牌桌通过原密钥保护，不会被匿名备份读取；需要保留旧记录时先在网站显式导入新版。

导出两次核对数据库版本和玩家列表，变化时重新读取；分页异常、记录缺失、访问失败时不覆盖上一份完整备份。现有查询最多支持 1000 场；达到服务查询上限或文件超过 80 MB 时明确失败，不截断记录。

这是成绩与牌局的备份，不包含旧设备的管理权限凭据；灾难恢复管理权限时需在服务端重新签发密钥。

## GitHub 目标仓库

备份仓库中需要以下文件：

```text
.github/workflows/backup-records.yml
scripts/backup-records.mjs
public/rules.mjs
public/stats.mjs
backups/database.json  # 首次运行后生成
```

当前按用户明确选择，备份保存到公开仓库 `lzl16/tmp`，与网站源码在同一仓库。`backups/database.json` 中的昵称和成绩公开可读。备选私有仓库 `lzl16/poker-score-records` 的工作流保持停用，不上传成绩。

## 服务端配置

仅在 `scorekeeper` 云函数的环境变量中配置：

| 名称 | 值 |
| --- | --- |
| `GITHUB_BACKUP_REPOSITORY` | `lzl16/tmp` |
| `GITHUB_BACKUP_BRANCH` | `main` |
| `GITHUB_BACKUP_TOKEN` | 仅该仓库的 fine-grained PAT，权限 `Actions: read and write` |

PAT 只允许触发该仓库的流程；流程使用 GitHub 自动提供的短期 `GITHUB_TOKEN` 写入备份。无需为备份流程配置腾讯云管理密钥或数据库直读权限。

PAT 必须由账号持有人在 GitHub 生成并直接填入云函数环境变量，不通过聊天、源码、终端参数、构建包或日志传递。过期后需要更新；补备份定时流程仍可独立运行。

新云函数 ZIP 需包含 `github-backup.cjs`。网页继续上传 `dist/` 中的静态文件。发布后先手动运行一次备份，检查内容和 GitHub 提交，再用一场明确标记的验收牌局验证结算后的自动触发。

## 本地预览

```bash
BACKUP_OUTPUT=artifacts/database-backup-preview.json node scripts/backup-records.mjs
```

该命令只读取网站已允许访客查看的数据并写入被 Git 忽略的预览文件，不修改数据库，不推送 GitHub。日志只输出数量和摘要，不打印完整玩家记录。

参考：[CloudBase 匿名认证](https://docs.cloudbase.net/http-api/auth/auth-sign-in-anonymously)、[函数 HTTP API](https://docs.cloudbase.net/http-api/functions/functions-post)、[GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)。
