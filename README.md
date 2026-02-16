# QQ 农场多账号挂机 + 可视化面板

基于 Node.js 的 QQ/微信经典农场自动化项目。  
当前版本以「多账号管理 + Web 面板」为核心，包含自动农场、好友互动、分析页、账号日志与扫码登录能力。
此项目基于AI编写，拥有优秀的PC/移动端控制页面

## 1. 当前版本功能总览

### 1.1 农场自动化
- 自动收获、自动铲除、自动种植
- 自动浇水、除草、除虫
- 自动卖果实
- 自动升级土地（可开关）
- LandsNotify 推送触发巡田（可开关）

### 1.2 好友自动化
- 自动好友巡查（可开关）
- 子开关独立控制：自动偷菜 / 自动帮忙 / 自动捣乱
- 支持好友互动静默时段（如 23:00-07:00）

### 1.3 面板能力
- 多账号管理（新增、编辑、删除、启动、停止）
- 扫码登录（QQ）
- 账号日志（添加/删除/踢下线删除/离线删除）
- 运行日志筛选（账号、模块、event、关键字、级别）
- 农场详情显示土地类型颜色（未解锁/黄/红/黑/金）
- 好友小卡片支持单好友一键操作：
  - 一键偷取
  - 一键浇水
  - 一键除草
  - 一键捣乱

### 1.4 分析页
- 常驻可见（无需先选账号）
- 排序方式：
  - 按经验效率
  - 按普通肥经验效率
  - 按等级要求

## 面板截图

### 桌面端

![桌面端面板截图](img/desktop.png)

### 移动端

![移动端面板截图](img/mobile.jpg)

## 2. 分析页公式说明（当前实现）

- `经验/时`  
  `作物收获经验 / 生长总秒数 * 3600`

- `普通肥经验/时`  
  若 `生长总秒数 * 0.2 < 30`：  
  `作物收获经验 / (生长总秒数 - 30) * 3600`  
  否则：  
  `作物收获经验 / (生长总秒数 * 0.8) * 3600`

- `等级要求`  
  使用 `gameConfig/Plant.json` 中的 `land_level_need`（不再从商店动态读取）。

## 3. 安装与启动

## 3.1 环境
- Node.js 18+

## 3.2 安装依赖

```bash
npm install
```

## 3.3 启动

```bash
node client.js
```

启动后会开启面板（默认端口 `3000`）：
- 本机：`http://localhost:3000`
- 局域网：`http://<你的IP>:3000`

## 3.4 面板登录

- 默认管理密码：`admin`
- 可通过环境变量修改：

```powershell
$env:ADMIN_PASSWORD="你的密码"
node client.js
```

## 4. 账号与登录

### 4.1 添加账号方式
- 手动录入 `Code`
- 面板扫码登录（QQ）

### 4.2 删除账号联动
- 手动删除账号后，前端立即更新
- 账号被踢下线时自动删除并记录账号日志
- 账号连续离线超过阈值会自动删除并记录账号日志
- 当账号为空时，统计/农场/好友页会清空为默认状态

## 5. 主要配置项

全局配置文件：`data/store.json`（运行中由面板保存）。

默认值定义见：`src/store.js`

- 自动化开关：
  - `farm`
  - `farm_push`
  - `land_upgrade`
  - `friend`
  - `friend_steal`
  - `friend_help`
  - `friend_bad`
  - `task`
  - `sell`
  - `fertilizer` (`both` / `normal` / `organic` / `none`)
- 种植策略：
  - `preferred`
  - `level`
- 巡查间隔：
  - `intervals.farm`
  - `intervals.friend`
- 好友静默时段：
  - `friendQuietHours.enabled`
  - `friendQuietHours.start`
  - `friendQuietHours.end`

服务基础配置见：`src/config.js`
- 面板端口：`adminPort`（默认 3000）
- 面板密码：`adminPassword`

## 6. 目录结构（核心）

```text
client.js                 # 主进程：多账号 worker 管理 + dataProvider
src/admin.js              # HTTP API + 静态面板
src/worker.js             # 单账号 worker 入口
src/farm.js               # 自己农场自动化逻辑
src/friend.js             # 好友逻辑 + 单好友操作
src/analytics.js          # 分析页计算逻辑
src/store.js              # 全局配置与账号持久化
src/gameConfig.js         # 游戏配置读取
panel/index.html          # 面板结构
panel/app.js              # 面板逻辑
panel/style.css           # 面板样式
gameConfig/Plant.json     # 作物配置（含 land_level_need）
```

## 7. 特别感谢

- 核心功能实现：[linguo2625469/qq-farm-bot](https://github.com/linguo2625469/qq-farm-bot)
- 扫码登录功能实现：[lkeme/QRLib](https://github.com/lkeme/QRLib)

## 8. 免责声明

本项目仅用于学习和研究。请自行评估并承担使用风险。
