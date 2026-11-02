# CloudBase 部署（v2）

当前站点使用上海免费体验环境、一个普通事件云函数和静态托管，不需要额外服务器。原环境及客户端数据库权限保持不变。

## 配置与构建

Node.js 18+：

```bash
npm test
npm run build
```

`public/config.js` 仅填写公开的环境 ID、地域和函数名；不得填写腾讯云 SecretId/SecretKey。

构建把 `public/` 复制到 `dist/`，并为 HTML、JS 模块导入及 CSS 添加基于内容哈希的版本参数，避免旧页面缓存混用接口。`rules.mjs` 和 `stats.mjs` 同时复制到云函数目录。

## 云函数

普通事件函数 `scorekeeper`，入口 `index.main`，Node.js 20.19，256 MB。当前免费版超时为 3 秒且不能调整，未购买升级。旧记录导入每次一场并返回 nextCursor，前端循环调用；每次导入事务最多约 13 次数据库操作，失败后重试不会覆盖原记录。

函数 ZIP 根目录包含：

```text
index.js
service.cjs
v2.cjs
github-backup.cjs
rules.mjs
stats.mjs
package.json
```

选择云端安装依赖；SDK 固定 `@cloudbase/node-sdk` 3.18.7。新版通过 `apiVersion: 2` 进入 `v2.cjs`，未带该字段的旧客户端继续使用 `service.cjs`。

## 数据与访问

每场结束后的 GitHub 数据备份配置见 [BACKUP.md](BACKUP.md)。GitHub 触发凭据仅保存在云函数环境变量，不能写入本目录或静态文件。

沿用 `scorekeeper_rooms` 集合，客户端权限 ADMINONLY。旧版文档为原随机编号；新版用户 `u_...`、牌局 `g_...` 以 kind 区分。公开返回使用字段白名单，管理密钥哈希不返回前端。名单采用昵称档案，无密码登录；本站访客可浏览新版牌局和成绩，写入牌局需要该场管理密钥。

云函数传统调用规则保持：

```json
{
  "*": {"invoke":"auth != null && auth.loginType != 'ANONYMOUS'"},
  "scorekeeper": {"invoke":"auth != null"}
}
```

身份认证启用匿名登录；这只用于 SDK 连通，不替代每场管理密钥校验。SDK 固定为官方 CDN 2.17.3，使用 auth().getLoginState() / signInAnonymously() / callFunction()。

不要通过开放数据库读写来解决前端访问问题。已有网站默认域名的安全来源保持原配置。

## 发布

先部署兼容旧版的云函数，再上传 `dist/` 内全部 7 个文件：index.html、styles.css、config.js、app.mjs、api.mjs、rules.mjs、stats.mjs。保持托管根目录 `/`。索引文档为 index.html，.mjs 必须使用 JavaScript MIME 类型。

可通过 CloudBase 静态托管“文件管理 → 上传文件”批量上传，或本地项目 ZIP 部署。不要上传项目根目录、云函数源码、测试数据或本机密钥。

验证：

1. 默认网址显示新版全局牌局入口，没有牌桌层级。
2. 创建昵称、在新建牌局中选择 5 位不同用户，或行内新增用户。
3. 保存牌局分数，刷新确认状态保留；仅有分享链接时不能改分。
4. 结束后核对累计升级、排名、角色局数和平均分。
5. 用户详情只累计已结束且非空牌局；历史角色均分按总分/局数加权。
6. 原设备或旧查看链接仍能查看旧记录，导入必须显式确认公开范围，并验证旧管理密钥。

## 免费条件

本次没有购买付费套餐。免费体验环境当前到期时间及续期条件见控制台，不承诺永久政策不变。CloudBase 默认域名仅供开发测试，会显示访问提示；正式使用需要考虑备案域名。

参考：[官方云函数安全规则](https://docs.cloudbase.net/cloud-function/security-rules)、[官方数据库事务](https://docs.cloudbase.net/database/transaction)、[官方静态项目部署](https://docs.cloudbase.net/hosting/web-hosting-static)、[官方默认域名限制](https://docs.cloudbase.net/service/alias)。
