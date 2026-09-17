# AntiPrint 微信小程序（kbone）

用 **kbone** 把 web 端的 React 代码「翻译」成微信小程序：小程序里的页面仍然是 React 组件，
由 kbone（`mp-webpack-plugin` + `miniprogram-render` + `miniprogram-element`）在小程序里模拟 DOM 与事件。

**本目录是独立工程，`frontend/`、`backend/`、`agent/` 的源码一律不动**；
只通过 webpack 别名 `@shared → ../frontend/src` **只读**复用 web 端的接口类型与常量，
保证状态字面量、打印选项、计费文案与网站完全一致（不会出现两端各写一份、改一端忘另一端）。

## 目录

```
miniprogram/
  webpack.config.js   入口（app + 5 个页面）、kbone 插件配置、@shared 别名、CSS 抽取
  tsconfig.json       给编辑器与 `npm run typecheck` 用的类型配置
  scripts/copy-runtime.js   构建后把 kbone 运行时放进 dist/miniprogram/miniprogram_npm
  src/
    index.js          app 入口：恢复登录态 + 全局样式
    api.ts            接口层（wx.request / wx.uploadFile / wx.downloadFile），令牌存 wx storage
    page.ts           每个页面入口的 createApp：挂 React、登录兜底、下拉刷新
    components.tsx    PageHeader（色带页头）/ Card / Row / Btn / Segmented / ChipRow / Stepper / Badge / Steps / Field / Alert
    util.ts           时间与金额格式化、状态徽章配色、进度步骤（jobSteps）、toast、二次确认、刷新回调
    app.css           全局样式（品牌色 token；构建后**内联进 app.wxss**，不依赖 @import）
    asset.ts          包内静态资源（品牌 logo —— 内联成 base64，**别改回文件路径**，见「logo 必须内联」）
    pages/            login / submit / jobs / balance / profile
  tabbar/             tabBar 图标（由 scripts/make_tab_icons.py 生成，进 git）
  scripts/
    make_tab_icons.py   生成 81×81 的 tabBar 图标（未选中灰 / 选中品牌青绿，纯标准库）
    copy-runtime.js     构建后处理：kbone 运行时 → miniprogram_npm、样式内联进 app.wxss（logo 不走文件，见下）
```

## 构建

```bash
cd miniprogram
npm install          # 首次
npm run build        # webpack + 放进 miniprogram_npm
npm run typecheck    # tsc --noEmit（strict）
```

产物（**`dist/` 本身就是小程序项目根**：代码根 = 项目根，按 kbone 官方约定不写 `miniprogramRoot`）：

```
dist/                             开发者工具导入这个目录
  project.config.json             项目配置（appid / libVersion / 不校验合法域名）
  app.js / app.json / app.wxss / config.js / sitemap.json
  common/                         webpack 产物（各页面 bundle；样式已内联进 app.wxss，这里不再留样式文件）
  images/                         只有 tabBar 图标（按 md5 命名；logo 已内联，不在这里）
  pages/<name>/index.{js,json,wxml,wxss}
  miniprogram_npm/                kbone 运行时（render + element）
```

## 在微信开发者工具里打开

1. 打开「微信开发者工具」→ 导入项目 → 目录选 **`miniprogram/dist`**（该目录根上就有 `app.json`，如果选到的目录里没有 `app.json` 就是选错了）。
2. AppID 目前填的是 `touristappid`（游客模式）。**要用真机/上传代码需要换成自己的小程序 AppID**。
3. 详情 → 本地设置 → 勾上「不校验合法域名、web-view、TLS 版本以及 HTTPS 证书」。
   **注意**：`npm run build` 会在 `dist/` 里写一份 `project.private.config.json`（`urlCheck: false` = 不校验），
   但开发者工具会用自己的本地设置**覆盖**这个文件 —— 2026-09-17 实测：界面上没勾这一项时，
   工具把它改回 `urlCheck: true`，于是点任务文件预览就报「downloadFile 合法域名校验出错」。
   遇到这个报错就去「详情 → 本地设置」把勾打上（构建脚本那份会被工具改写，改文件没用）。
4. **服务器地址固定为 `https://print.anticraft.top`**（`src/api.ts` 里的 `SERVER` 常量，界面上没有开关）——
   上线前记得在小程序后台把该域名加进 request / uploadFile / downloadFile 合法域名。

## 给别人用（不需要 Node / Python）

```bash
bash deploy/pack-miniprogram.sh          # 构建 + 打包 → dist/AntiPrintMiniProgram-<版本>.zip
```

收包的人只要有「微信开发者工具」：解压 → 导入解压出来的文件夹（根上直接有 `app.json`）→ 编译即可，
包里带一份「导入说明.txt」（含上传发布与域名白名单步骤）。小程序**用户端**更是零安装：手机上用微信打开就能提交打印。

> 三个已在开发者工具里实测踩过、并已修掉的坑（改动前先看一眼）：
>
> 1. **项目根必须 = 代码根**：kbone 生成的路径（`app.wxss` 里 `@import "common/…"`、页面 wxss 里 `@import "../../common/…"`、
>    `sitemap.json`、tabBar 图标目录）都是按「代码根 = 项目根」算的。加 `miniprogramRoot` 或选到 `dist/` 的上一层，
>    会分别报 `在项目根目录未找到 app.json` / 找不到样式。**判断选对了没有：目录里直接就有 `app.json`。**
> 2. **抽出来的样式必须是 `.wxss`**：`MiniCssExtractPlugin({ filename: '[name].wxss' })`。小程序的 `@import` 只认 wxss，
>    写成 `.css`（即便文件真实存在）开发者工具会报 ``path `common/app.css` not found from `./app.wxss` ``。
> 3. **图片必须内联成 data URI，不能写包内路径**（2026-09-17，用户报「登录页图片裂了」）：
>    kbone 的 `<img>` 投影会做 URL 补全（`miniprogram-element/src/util/tool.js` 的 `completeURL()` —— `src` 以 `/` 开头就
>    拼上 origin），于是标准的包内绝对路径 `/images/antiprint-logo.png` 会变成 `https://<origin>/images/…` 这种**网络地址**，
>    小程序拿不到图 → 图裂。`data:` URI 不在补全范围内、`<image>` 官方支持 base64，所以 logo 内联在 `src/asset.ts`
>    （换 logo 跑 `node .tmp-test/make-miniprogram-logo.cjs`；`miniprogram_test.cjs` 里有「内联的就是网站那份 PNG」的守卫断言）。

## 界面

- **顶部**：小程序导航栏用品牌青绿（`app.json` 的 window 段，白字），页面顶部再有一段同色「色带」（`PageHeader`）——
  两层同色连成一片，色带里放页面标题、说明与一枚信息胶囊（计费/余额、任务数、刷新提示）。
- **内容**：暖米白底 + 白色卡片，第一张卡片上移 24px 压住色带底边；卡片内是「标签 + 值」行、文件行、提示条、状态徽章。
- **进度**：任务卡片带四步进度（已提交 → 审核 → 打印 → 交接），已完成的步骤与连线是品牌色、当前步带光圈；
  驳回/撤回/打印失败这类支线不显示进度条，改用提示条说明。
- **操作**：提交页的按钮固定在底部操作条（`position: fixed`，页面视口本来就在原生 tabBar 之上，
  所以下内边距只留 6px、**不再叠 `env(safe-area-inset-bottom)`** —— 叠了会在刘海机型/模拟器上多出一截空隙），
  触摸高度统一 ≥44px；底部 tabBar 是四个自绘图标（上传/文档/¥/滑杆）。
- **打印设置默认收起**（2026-09-17）：提交页的「打印设置」卡片默认只显示标题 + 一行设置摘要
  （`describePrintOptions` 生成的「2 份 · A4 · 第 1-3 页 · 每张 4 页 · 适应纸张」），点标题才展开份数 / 纸张大小 / 页面范围 /
  排版（每张页数）/ 缩放（卡片头 `.card-head-tap` 撑到 44px 触摸高度）。纸张固定 A4，不给换纸。
- **文件来源**：只有「选择文件（聊天记录里选）」和「拍照或从相册选图片」两条——微信**没有开放浏览手机文件系统的接口**
  （官方 `choose*` 系列里只有 `wx.chooseMessageFile`（从客户端会话选择）与 `wx.chooseMedia`（相册/拍照），
  `wx.getFileSystemManager()` 只能读写小程序沙箱 `wx.env.USER_DATA_PATH`）。
  手机里的文件要先在微信里发给「文件传输助手」，再从聊天记录里选（这句提示就写在界面上）。
- **预览入口**：选完文件后文件行下有一整行「预览文件 / 移除」按钮，图片还会直接显示缩略图；
  「我的任务」里没有单独的按钮，**点文件名**就能预览（2026-09-17 按用户要求去掉了那一列按钮）。
- **改图标**：`backend\.venv\Scripts\python.exe miniprogram/scripts/make_tab_icons.py`（纯标准库手写 PNG，产物进 `tabbar/`）。
- **本地预览**（没有开发者工具时看效果）：`node .tmp-test/miniprogram_preview.mjs [页面…]` —— 用 kbone 运行时把产物渲染成 HTML，
  套上真实编译出来的 wxss、外加导航栏/tabBar 外壳，chromium 截图到 `.tmp-test/shots/miniprogram/`，
  并顺带做**横向溢出检查**（任何元素右边缘超过 375px 都会在输出里标出来）。
- **样式里的 box-sizing 要手写**：WXSS 不支持 `*` 选择器，凡 `width:100%` 或带左右 padding 的容器都要自己写
  `box-sizing: border-box`，否则会宽出父容器（按钮右端顶出屏幕就是这么来的，2026-09-16 踩过）。

## 页面对应关系（与 web 端）

| 小程序页面 | DOM 路由 | 对应 web 页面 | 说明 |
|---|---|---|---|
| `pages/login/index` | `/login` | `LoginPage` | 账号密码登录 / 注册（服务器地址写死在 `src/api.ts` 的 `SERVER`，界面上不显示入口） |
| `pages/submit/index` | `/submit` | `SubmitPage` | 选文件（聊天文件 / 相册图片，**可先预览**）→ 打印设置（默认收起：份数 / 纸张大小固定 A4 / 页面范围 / 排版每张页数 / 缩放，与网站同一套取值）→ 配送方式与地址 → 提交，402 会提示余额不足 |
| `pages/jobs/index` | `/jobs` | `MyJobsPage` | 15 秒自动刷新 + 下拉刷新；撤回、点文件名预览 |
| `pages/balance/index` | `/balance` | `BalancePage` | 余额、账号类型（免费/计费）、最近流水 |
| `pages/profile/index` | `/profile` | `ProfilePage` | 默认配送方式与地址、账号信息、退出登录 |

底部 TabBar（纯文字，不配图标）：提交打印 / 我的任务 / 我的余额 / 我的配置。

## 与 web 端的差异（有意为之）

- **一次只提交一个文件**：小程序端 `wx.uploadFile` 一次只能传一个文件，而后端只支持「建单时带上文件」（没有追加文件接口），
  所以小程序按单文件提交；要打多份就分多次提交（web 端仍是一次最多 5 个）。
- **没有管理端**：审核、任务队列、管理设置等管理功能仍只在网站上做（小程序只面向提交打印的用户）。
- **没有 anticraft 跳转授权**：小程序里打不开外部授权页，只做账号密码登录 / 注册
  （anticraft 账号可在网站上完成绑定后再用）。
- **没有头像上传**：头像接口需要 `Authorization` 头，小程序 `<image src>` 带不了请求头，`wx.downloadFile` 又要走
  request 合法域名白名单，因此小程序不做头像（不影响任何打印功能）。
- **没有 Word/PPT 预览转 PDF 的「先预览再提交」两步**：提交时的转换由后端完成，任务详情里点文件名看到的就是转换后的 PDF。
- **样式是等价的 wxss 类名**（不是 Tailwind）：`src/app.css` 用与网站相同的品牌色 token（暖米白 #faf8f5 / 青绿 #4a9d9a /
  琥珀 #e8b86d / 陶土 #c17767 / 灰青 #6b8e8e），类名（`card`/`btn-primary`/`badge-amber`…）与网站配方一一对应。
- **每个页面独立打包**：没有拆公共 chunk，所以每个页面包里各带一份 React（约 165KB/页）。实测主包合计约 **1.1MB**
  （含 kbone 运行时，微信上限 2MB，仍有余量）。要再省体积可以配 `optimization.splitChunks` 或把页面挪到分包（kbone 支持 `generate.subpackages`）。

## 验证

```bash
node .tmp-test/miniprogram_test.cjs      # 在仓库根目录跑（69 项）
```

这个用例用 Node 直接跑 kbone 的 `miniprogram-render` 运行时，把 webpack 产物里的 5 个页面真的挂起来：
断言 React 渲染出的文本、状态徽章配色、`location` 跳转（未登录兜底 / 已登录跳提交页），
并用 kbone 的冒泡事件模拟点击 —— 覆盖「选文件 → 提交（校验 multipart 字段：配送/份数/纸张/页面范围/排版/缩放）→ 成功卡片」
「打印设置默认收起 → 点标题展开」「余额不足 402 → 付款码提示」「撤回任务 → 二次确认 → 调接口 → 提示」
「点文件名 → 下载（带令牌）」「预览失败时 loading 先收再弹提示（开发者工具报过『showLoading 与 hideLoading 必须配对使用』）」。

**用例没有覆盖的**（需要真机 / 微信开发者工具）：wxss 样式渲染、`miniprogram-element` 的 wxml 投影、
`wx.chooseMessageFile` 等真实小程序 API、request 合法域名与 https 证书、真机触摸与键盘。

## 一些实现约定（改之前先看）

- **跳转只用 `src/page.ts` 的 `go()` / `goLogin()`**：tabBar 页直接 `wx.switchTab`（不带 query），非 tabBar 页才走 kbone 的
  `location.href`；`goLogin()` 用 `wx.reLaunch`。
- **登录态过期自动回登录页**：任何接口返回 401 → 清本地令牌 + `reLaunch` 到登录页。
- **tabBar 页切走再切回不会重建**：页面用 `onShow(fn)` 注册「重新显示」回调（kbone 的 `wxshow`）来清结束态；
  提交页就是靠它从「提交成功」回到表单首页。
- **样式里的 `box-sizing` 要手写**（wxss 不支持 `*`）；改完界面跑 `node .tmp-test/miniprogram_preview.mjs` 看截图 + 溢出检查。

## 已知限制

- `dist/` 与 `node_modules/` 不入库；改完代码要重新 `npm run build`（开发者工具不会自己编译 webpack 产物）。
- 默认服务器是 `http://127.0.0.1:8301`（本机后端），避免误连线上打出真纸；上线时在登录页「服务器地址」改成
  `https://print.anticraft.top`，并在小程序后台把它加进 **request / uploadFile / downloadFile 合法域名**。
- 本地开发时如果后端没起，页面只会在请求处报「网络请求失败」，不会崩。
