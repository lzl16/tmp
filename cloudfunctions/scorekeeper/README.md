# 记分云函数

这是 CloudBase **普通事件云函数**，入口 `index.main`，不是 HTTP/Web 云函数。前端通过 CloudBase Web SDK 的 `callFunction({ name: 'scorekeeper', data: request })` 调用。Node.js 18 及以上可用。

部署前把 `public/rules.mjs` 复制到本目录的 `rules.mjs`，安装本目录依赖，再上传整个目录。`public/rules.mjs` 是规则的唯一源文件；修改后必须重新复制，避免浏览器预览与云端结算不一致。

数据库创建集合 `scorekeeper_rooms`，**客户端读、写全部禁止**。所有访问都经过本云函数，云函数使用环境内置身份访问数据库。不要把腾讯云 SecretId、SecretKey 或 API Key 放进网页，也不要开放数据库权限作为部署捷径。

## 调用约定

```js
{ action, roomId, readKey, writeKey, expectedVersion, payload }
```

- `createRoom`：`payload: { title? }`，返回 `{ room, readKey, writeKey }`。两个随机密钥只在创建时返回，请妥善保存管理链接。
- `getRoom`：需 `roomId` 和 `readKey` 或 `writeKey`，返回 `{ room }`。
- 以下写操作需 `roomId`、`writeKey`、最新 `expectedVersion`，返回 `{ room }`：
  - `createGame`：`payload: { players: [五个不重复名字，按固定座位顺序], mainDealer: 0至4 }`。
  - `addRound`：`payload: { gameId, viceDealer: 0至4, score: 闲家合计非负整数 }`。
  - `undoRound`、`finishGame`：`payload: { gameId }`。
- 业务失败返回 `{ error: { code, message } }`。`STALE_VERSION` 时先重新拉取房间，展示新状态后由用户重新提交；不能静默用新版本重复记分。

`room` 的安全字段为 `id, title, version, createdAt, updatedAt, games`。`games` 按创建时间正序，每场有 `players, initialMainDealer, mainDealer, levels, status, createdAt, finishedAt, rounds`。等级是 `"2"` 到 `"A"` 的字符串；庄家为零起始座位索引。每局记录有 `mainDealer, viceDealer, score, dealerUpgrade, idleUpgrade, levelsBefore, levelsAfter, nextMainDealer` 等字段。

管理密钥为 256 位随机值，云端仅保存分别加盐的 scrypt 哈希。查看链接也包含随机密钥；获得查看链接的人可以查看，获得管理链接的人可以改分。不要把管理链接发到公共群。前端分享应只使用查看链接，并将密钥放在 URL fragment 以避免它进入网页请求与常规访问日志。

每房间最多 50 场、每场最多 200 局，且整体文档限制在 900 KB 以下，以保留数据库文档大小余量。到上限后导出历史并创建新房间；第一版不删除历史。写入使用数据库事务并比较版本，两个设备重复提交同一版本只能成功一次。

本地的 `node --test tests/*.test.mjs` 使用内存事务模拟器验证规则、权限及版本冲突；实际云端数据库、SDK 调用、匿名登录及托管域名仍须部署后联调确认。

参考官方文档：[数据库事务](https://docs.cloudbase.net/database/transaction)、[云函数调用资源](https://docs.cloudbase.net/cloud-function/resource-integration/cloudbase)。
