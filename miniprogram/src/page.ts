// 页面创建：kbone 要求每个页面入口「默认导出 createApp」，由小程序端调用它拿到应用实例
// （见 mp-webpack-plugin 的 page.base.tmpl：init(window, document) 之后会调用 window.createApp()）。
// 登录兜底与下拉刷新接线收敛在这里，页面入口只写自己的 JSX。
import type { ReactElement } from 'react'
import * as ReactDOM from 'react-dom'
import api from './api'
import { getUiScale, triggerRefresh, triggerShow } from './util'

// kbone 页面私有的 window/document（只用到这几个能力，按需声明）
interface KboneWindow {
  location: { href: string; pathname: string }
  addEventListener: (name: string, handler: () => void) => void
}

interface KboneNode {
  className: string
}

interface KboneDocument {
  createElement: (tag: string) => KboneNode
  body: { appendChild: (node: unknown) => void; className: string }
}

/** createApp 的返回值：kbone 在页面卸载时会调用 unmount / $destroy */
export interface PageApp {
  unmount: () => void
}

let pageWindow: KboneWindow | null = null
let pageDocument: KboneDocument | null = null

/**
 * 套用界面字号档位：kbone 会把 body 上的 class 同步到页面根元素，
 * wxss 里的 .h5-body.scale-lg / .scale-xl 只覆盖几个字号变量即可整页缩放。
 */
export function applyUiScale(): void {
  if (!pageDocument) return
  const scale = getUiScale()
  pageDocument.body.className = scale === 'lg' ? 'scale-lg' : scale === 'xl' ? 'scale-xl' : ''
}

/**
 * 创建页面（页面入口里 `export default function createApp() { return createPage(...) }`）。
 * - auth 默认为 true：没有令牌就不渲染，直接跳登录页（kbone 自己判断 tabBar 页用 switchTab）
 * - 自动接管下拉刷新：页面里用 onRefresh(fn) 注册刷新函数
 */
export function createPage(
  window: unknown,
  document: unknown,
  element: ReactElement,
  options: { auth?: boolean } = {},
): PageApp {
  const win = window as KboneWindow
  const doc = document as KboneDocument
  pageWindow = win
  pageDocument = doc
  applyUiScale()
  win.addEventListener('pulldownrefresh', triggerRefresh)
  // 切回本页（tab 页不会重建）时也通知一次，页面可以据此把结束态清掉
  win.addEventListener('wxshow', triggerShow)
  // 任何请求拿到 401（令牌过期/失效）都自动回登录页，和 web 端行为一致
  api.onAuthExpired = goLogin

  // 每个页面的 JS 是独立打包的（各自一份 api 实例），进页面时都要从本地缓存恢复登录态
  api.restoreToken()

  if (options.auth !== false && !api.token) {
    win.location.href = '/login'
    return { unmount: () => undefined }
  }

  const root = doc.createElement('div')
  root.className = 'page-root'
  doc.body.appendChild(root)
  const container = root as unknown as Element
  ReactDOM.render(element, container)
  return {
    unmount() {
      ReactDOM.unmountComponentAtNode(container)
    },
  }
}

/** tabBar 页面（小程序路径）：跳这些页面要直接 switchTab —— 走 kbone 的 location 会带上 query，
    而微信的 wx.switchTab 不支持 queryString，会一直刷「url 不支持 queryString」告警 */
const TAB_PAGES: Record<string, string> = {
  '/submit': '/pages/submit/index',
  '/jobs': '/pages/jobs/index',
  '/balance': '/pages/balance/index',
  '/profile': '/pages/profile/index',
}

/** 退出登录（或登录态过期）回登录页：reLaunch 会清掉所有页面栈，tab 页里也能跳 */
export function goLogin(): void {
  wx.reLaunch({ url: '/pages/login/index' })
}

/** 页面跳转：tabBar 页走 switchTab，其余页面走 kbone 的 location（需要它带 targeturl 才能定位到页面） */
export function go(path: string): void {
  const tab = TAB_PAGES[path]
  if (tab) {
    wx.switchTab({ url: tab })
    return
  }
  if (pageWindow) pageWindow.location.href = path
  else wx.redirectTo({ url: `/pages${path}/index` })
}
