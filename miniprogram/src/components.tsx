// 公共组件：色带页头 / 卡片 / 按钮 / 分段 / 选项块 / 份数 / 状态徽章 / 进度步骤
// 样式都在 src/app.css（编译进 app.wxss），类名与网站配方一一对应
import * as React from 'react'
import { LOGO_PATH } from './asset'
import { statusClass } from './util'
import type { JobStatus } from '@shared/types/api'

/** 顶部品牌色带：与导航栏同色，页面标题 + 说明 + 右侧信息 */
export function PageHeader(props: {
  title: string
  subtitle?: string
  pill?: string
  logo?: boolean
  right?: React.ReactNode
}) {
  return (
    <div className="hero">
      <div className="hero-row">
        {props.logo ? <img className="hero-logo" src={LOGO_PATH} /> : null}
        <div className="grow">
          <div className="hero-title">{props.title}</div>
          {props.subtitle ? <div className="hero-sub">{props.subtitle}</div> : null}
        </div>
        {props.right ? <div className="hero-right">{props.right}</div> : null}
      </div>
      {props.pill ? <div className="hero-pill">{props.pill}</div> : null}
    </div>
  )
}

export function Card(props: { title?: string; extra?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="card">
      {props.title || props.extra ? (
        <div className="card-head">
          <div className="card-title">{props.title}</div>
          {props.extra ? <div className="card-extra">{props.extra}</div> : null}
        </div>
      ) : null}
      {props.children}
    </div>
  )
}

/** 一行「标签 + 值」 */
export function Row(props: { label: string; children?: React.ReactNode; strong?: boolean }) {
  return (
    <div className="row">
      <div className="row-label">{props.label}</div>
      <div className={`row-value grow ellipsis${props.strong ? ' strong' : ''}`}>{props.children}</div>
    </div>
  )
}

/** 提示条：error=陶土红 / ok=品牌绿 / info=中性（与网站语义色一致） */
export function Alert(props: { kind: 'error' | 'ok' | 'info'; children?: React.ReactNode }) {
  return <div className={`alert alert-${props.kind}`}>{props.children}</div>
}

export function Empty(props: { text: string }) {
  return <div className="empty">{props.text}</div>
}

/** 按钮：小程序里 div + 点击事件最稳（wx 的 button 自带样式与 after 边框） */
export function Btn(props: {
  children?: React.ReactNode
  onClick?: () => void
  kind?: 'primary' | 'secondary' | 'danger' | 'ghost'
  size?: 'md' | 'sm'
  disabled?: boolean
  block?: boolean
}) {
  const classes = ['btn', `btn-${props.kind || 'primary'}`]
  if (props.size === 'sm') classes.push('btn-sm')
  if (props.block) classes.push('btn-block')
  if (props.disabled) classes.push('btn-disabled')
  return (
    <div className={classes.join(' ')} onClick={props.disabled ? undefined : props.onClick}>
      {props.children}
    </div>
  )
}

/** 分段选择（配送方式、登录/注册这类二选一） */
export function Segmented<T extends string>(props: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="seg">
      {props.options.map((item) => (
        <div
          key={item.value}
          className={`seg-item${item.value === props.value ? ' seg-item-on' : ''}`}
          onClick={() => props.onChange(item.value)}
        >
          {item.label}
        </div>
      ))}
    </div>
  )
}

/** 横向可换行的选项块（纸张等枚举值） */
export function ChipRow<T extends string>(props: {
  value: string
  options: readonly T[]
  onChange: (value: T) => void
}) {
  return (
    <div className="chips">
      {props.options.map((item) => (
        <div key={item} className={`chip${item === props.value ? ' chip-on' : ''}`} onClick={() => props.onChange(item)}>
          {item}
        </div>
      ))}
    </div>
  )
}

/** 份数：加减 + 数字（避免在小程序里做数字输入框） */
export function Stepper(props: { value: number; min: number; max: number; onChange: (value: number) => void }) {
  const minus = () => props.value > props.min && props.onChange(props.value - 1)
  const plus = () => props.value < props.max && props.onChange(props.value + 1)
  return (
    <div className="stepper">
      <div className={`stepper-btn${props.value <= props.min ? ' stepper-btn-off' : ''}`} onClick={minus}>
        −
      </div>
      <div className="stepper-value">{props.value}</div>
      <div className={`stepper-btn${props.value >= props.max ? ' stepper-btn-off' : ''}`} onClick={plus}>
        +
      </div>
    </div>
  )
}

export function Field(props: { label: string; hint?: string; last?: boolean; children?: React.ReactNode }) {
  return (
    <div className={`field${props.last ? ' field-last' : ''}`}>
      <div className="field-label">{props.label}</div>
      {props.children}
      {props.hint ? <div className="field-hint">{props.hint}</div> : null}
    </div>
  )
}

export function Badge(props: { status: JobStatus | string }) {
  return <div className={statusClass(props.status)}>{props.status}</div>
}

/** 状态进度：提交 → 审核 → 打印 → 交接 */
export function Steps(props: { items: { label: string; state: 'done' | 'now' | 'todo' }[] }) {
  return (
    <div className="steps">
      {props.items.map((item, index) => (
        <React.Fragment key={item.label}>
          {index > 0 ? <div className={`step-link${item.state === 'todo' ? '' : ' step-link-on'}`} /> : null}
          <div className={`step${item.state === 'todo' ? '' : ' step-on'}${item.state === 'now' ? ' step-now' : ''}`}>
            <div className="step-dot" />
            <div className="step-text">{item.label}</div>
          </div>
        </React.Fragment>
      ))}
    </div>
  )
}
