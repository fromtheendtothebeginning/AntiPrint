// 小程序应用入口（kbone 约定：入口模块导出 function(window, document)，小程序端 require 后调用）
// 这里只负责「应用级」的事：恢复登录态 + 引入全局样式（会被打包进 app.wxss）
const api = require('./api').default
require('./app.css')

// app.js 先于所有页面被执行：先把本地缓存里的令牌恢复出来（页面入口要用）
api.restoreToken()

// kbone 的 app.tmpl.js 会读 fakeWindow.appOptions 交给小程序的 App()，所以要在模块顶层赋值。
// 注意：app 入口里 kbone 注入的 window 是空对象（fakeWindow），不能碰 document。
window.appOptions = {
    onLaunch() {
        api.restoreToken()
    },
}

// webpack 的 library 配置要求每个入口有默认导出（页面入口导出的是 createApp）；
// app 入口不需要「创建应用」，给一个空实现让产物保持一致。
export default function createApp() {
    return { unmount() {} }
}
