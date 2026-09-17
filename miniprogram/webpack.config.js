// webpack 配置：kbone（mp-webpack-plugin）把 React 代码编译成微信小程序
// 与 frontend/ 完全独立 —— web 端源码不动，这里只通过别名复用它的常量与类型定义
const path = require('path')
const MpWebpackPlugin = require('mp-webpack-plugin')
const MiniCssExtractPlugin = require('mini-css-extract-plugin')

// 页面清单：一个页面一个 entry（kbone 要求 entry 名 = 页面目录名），
// route 是该页面在「DOM 里」的地址（跳转用 location.href = '/jobs'），title 是小程序导航栏标题
const PAGES = [
  { name: 'login', route: '/login', title: '登录' },
  { name: 'submit', route: '/submit', title: '提交打印' },
  { name: 'jobs', route: '/jobs', title: '我的任务' },
  { name: 'balance', route: '/balance', title: '我的余额' },
  { name: 'profile', route: '/profile', title: '我的配置' },
]

const entry = { app: path.resolve(__dirname, 'src/index.js') }
// 注意：router / pages 的 key 都是「页面名」（kbone 内部按 pages/<页面名>/index 组装小程序路径）
const router = {}   // 页面名 → 该页面对应的 DOM 地址（跳转用 location.href = '/jobs'）
const pages = {}    // 页面名 → 页面配置（defaultTargetUrl 让每个页面有自己的 DOM 地址）
PAGES.forEach(({ name, route, title }) => {
  entry[name] = path.resolve(__dirname, `src/pages/${name}/index.tsx`)
  router[name] = [route]
  pages[name] = {
    defaultTargetUrl: route,
    // 任务列表支持下拉刷新（对应 wx 的 enablePullDownRefresh）
    pullDownRefresh: name === 'jobs',
    // 每个页面自己的导航栏标题（服务端导航栏 + 页面色带标题各司其职）
    extra: { navigationBarTitleText: title },
  }
})

// tabBar 图标：由 scripts/make_tab_icons.py 生成（81×81，未选中灰 / 选中品牌青绿）
const TAB_ICON_DIR = path.resolve(__dirname, 'tabbar')

module.exports = {
  mode: 'production',
  devtool: false,
  entry,
  output: {
    // kbone 约定：webpack 产物进 <项目根>/common/，页面文件由插件写到 <项目根>/pages/。
    // 项目根就是 dist/（开发者工具导入 miniprogram/dist），插件生成的 @import 路径都是按
    // 「代码根 = 项目根」算的 —— 不要再套一层目录或加 miniprogramRoot（2026-09-16 踩过）。
    path: path.resolve(__dirname, 'dist/common'),
    filename: '[name].js',
    globalObject: 'window',   // 小程序里没有 self/globalThis 兜底，用 kbone 包装函数传入的 window
    // 每个页面入口默认导出的 createApp 挂到页面私有的 window 上，供 kbone 的页面模板调用
    library: { name: 'createApp', type: 'window', export: 'default' },
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.jsx', '.js'],
    // @shared 指向 frontend/src（仓库另一个目录），裸包名（core-js 等）要在本工程里解析
    modules: [path.resolve(__dirname, 'node_modules'), 'node_modules'],
    alias: {
      // 复用 web 端源码（只读引用，不修改它）：接口类型 + 状态/选项常量（唯一事实来源）
      '@shared': path.resolve(__dirname, '../frontend/src'),
    },
  },
  module: {
    rules: [
      {
        test: /\.[jt]sx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              // 目标定在「微信 JSCore 实际水平」：语法按需降级，内置对象按需补（Object.fromEntries 等）
              ['@babel/preset-env', {
                targets: { ios: '12', chrome: '70' },
                useBuiltIns: 'usage',
                corejs: 3,
              }],
              ['@babel/preset-react', { runtime: 'classic' }],
              '@babel/preset-typescript',
            ],
          },
        },
      },
      {
        // kbone 把各入口的 CSS 收进小程序的 wxss（app 入口的进 app.wxss）
        test: /\.css$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
    ],
  },
  performance: { hints: false },
  plugins: [
    // 必须抽成 .wxss：小程序的 @import 只认 wxss 文件，写成 .css 时开发者工具会报
    // 「path `common/app.css` not found from `./app.wxss`」（文件在也不认，2026-09-16 踩过）
    new MiniCssExtractPlugin({ filename: '[name].wxss' }),
    new MpWebpackPlugin({
      origin: 'https://miniprogram.default',
      entry: 'app',
      router,
      pages,
      // app.json 的 window 段（导航栏用品牌青绿 + 白字，与页面顶部色带连成一片）
      app: {
        navigationBarBackgroundColor: '#4a9d9a',
        navigationBarTextStyle: 'white',
        navigationBarTitleText: 'AntiPrint 远程打印',
        backgroundColor: '#faf8f5',
        backgroundTextStyle: 'light',
      },
      // 页面都允许被搜索到（任务内容本身需要登录，不受影响）
      sitemapConfig: {
        desc: 'AntiPrint 远程打印：提交文件 → 管理员审核 → 本机静默打印',
        rules: [{ action: 'allow', page: '*' }],
      },
      // 不覆盖 optimization：kbone 默认值最稳（elementMulticlass 等会改变 class 投影方式）
      generate: {
        app: 'app',
        appEntry: 'app',
        // project.config.json 写到 dist/ 根上（= 项目根 = 代码根；插件默认就是 ../project.config.json）
        projectConfig: path.resolve(__dirname, 'dist'),
        // 底部 TabBar：与 web 端侧栏的「日常入口」对齐；图标用自己画的线性图标（同品牌色系）
        tabBar: {
          color: '#8a8a86',
          selectedColor: '#4a9d9a',
          backgroundColor: '#ffffff',
          borderStyle: 'black',
          list: [
            { pageName: 'submit', text: '提交打印', iconPath: path.join(TAB_ICON_DIR, 'submit.png'), selectedIconPath: path.join(TAB_ICON_DIR, 'submit-on.png') },
            { pageName: 'jobs', text: '我的任务', iconPath: path.join(TAB_ICON_DIR, 'jobs.png'), selectedIconPath: path.join(TAB_ICON_DIR, 'jobs-on.png') },
            { pageName: 'balance', text: '我的余额', iconPath: path.join(TAB_ICON_DIR, 'balance.png'), selectedIconPath: path.join(TAB_ICON_DIR, 'balance-on.png') },
            { pageName: 'profile', text: '我的配置', iconPath: path.join(TAB_ICON_DIR, 'profile.png'), selectedIconPath: path.join(TAB_ICON_DIR, 'profile-on.png') },
          ],
        },
      },
      projectConfig: {
        appid: 'touristappid',
        projectname: 'AntiPrint',
        compileType: 'miniprogram',
        libVersion: '2.32.3',
        setting: {
          urlCheck: false,        // 开发期后端是 http://127.0.0.1:8301，需关掉域名校验
          es6: true,
          minified: true,
        },
      },
    }),
  ],
}
