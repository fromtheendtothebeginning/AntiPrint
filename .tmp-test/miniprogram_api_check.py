"""小程序端接口契约实测（用小程序真正发的请求打真实后端）。

小程序侧三种请求：wx.request（JSON）、wx.uploadFile（multipart，字段名 files）、wx.downloadFile（带头下载）。
这里用 requests 按同样的形状打一遍，确认：
  1. 注册/登录返回 {token, user}
  2. /api/profile 带 default_address / default_delivery / billable / price / balance（提交页要用来预填与显示计费）
  3. /api/balance 返回 balance/billable/price/logs（余额页要用的字段）
  4. /api/jobs/mine 返回 {jobs:[...]}（任务页）
  5. multipart 提交用字段名 files + address/delivery_mode/copies/paper → 新账号余额 0，期望 402 且 detail 是
     {code: insufficient_balance, cost, balance, sheets}（小程序据此弹「余额不足」提示）
探针账号是本机新建的普通账号（余额 0），不碰线上、不用任何已有账号的口令。
用法：backend\\.venv\\Scripts\\python.exe .tmp-test/miniprogram_api_check.py
"""
import io
import json
import sys
import time

import requests

BASE = 'http://127.0.0.1:8301'
passed = 0
failed = 0


def check(name, ok, extra=''):
    global passed, failed
    if ok:
        passed += 1
        print(f'  [OK] {name}')
    else:
        failed += 1
        print(f'  [FAIL] {name} → {extra}')


def tiny_pdf() -> bytes:
    """一页的最小合法 PDF（与 cover.py 里的思路一致：手工拼一个能数出 1 页的 PDF）"""
    objects = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
    ]
    out = io.BytesIO()
    out.write(b'%PDF-1.4\n')
    offsets = []
    for index, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(f'{index} 0 obj\n'.encode())
        out.write(body + b'\nendobj\n')
    start_xref = out.tell()
    out.write(f'xref\n0 {len(objects) + 1}\n'.encode())
    out.write(b'0000000000 65535 f \n')
    for offset in offsets:
        out.write(f'{offset:010d} 00000 n \n'.encode())
    out.write(f'trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{start_xref}\n%%EOF\n'.encode())
    return out.getvalue()


def main():
    print('\n[1] 注册探针账号（小程序登录页「注册」走的就是这个接口）')
    username = f'mp_probe_{int(time.time())}'
    res = requests.post(f'{BASE}/api/register', json={'username': username, 'password': 'probe-pass-123'}, timeout=20)
    check('POST /api/register 返回 {token, user}', res.status_code == 200 and 'token' in res.json() and 'user' in res.json(), f'{res.status_code} {res.text[:120]}')
    token = res.json().get('token', '')
    headers = {'Authorization': f'Bearer {token}'}

    print('\n[2] 小程序各页读取的接口')
    res = requests.post(f'{BASE}/api/login', json={'username': username, 'password': 'probe-pass-123'}, timeout=20)
    check('POST /api/login 返回 {token, user}', res.status_code == 200 and 'token' in res.json(), f'{res.status_code} {res.text[:120]}')

    res = requests.get(f'{BASE}/api/profile', headers=headers, timeout=20)
    profile = res.json().get('profile', {}) if res.status_code == 200 else {}
    check(
        'GET /api/profile 带提交页/配置页要用的字段',
        res.status_code == 200
        and all(key in profile for key in ('default_address', 'default_delivery', 'billable', 'price', 'balance')),
        f'{res.status_code} {json.dumps(profile, ensure_ascii=False)[:160]}',
    )

    res = requests.get(f'{BASE}/api/balance', headers=headers, timeout=20)
    balance = res.json() if res.status_code == 200 else {}
    check(
        'GET /api/balance 带余额页要用的字段',
        res.status_code == 200 and all(key in balance for key in ('balance', 'billable', 'price', 'logs', 'recharge_enabled')),
        f'{res.status_code} {json.dumps(balance, ensure_ascii=False)[:160]}',
    )

    res = requests.get(f'{BASE}/api/jobs/mine', headers=headers, timeout=20)
    check('GET /api/jobs/mine 返回 {jobs:[...]}', res.status_code == 200 and isinstance(res.json().get('jobs'), list), f'{res.status_code} {res.text[:120]}')

    print('\n[3] 提交（multipart，字段名与小程序一致）→ 新账号余额 0，期望 402 余额不足')
    files = {'files': ('小程序探针.pdf', tiny_pdf(), 'application/pdf')}
    form = {'address': '小程序探针地址 101', 'delivery_mode': '配送', 'note': '接口契约实测', 'copies': '1', 'paper': 'A4'}
    res = requests.post(f'{BASE}/api/jobs', headers=headers, files=files, data=form, timeout=60)
    detail = {}
    try:
        detail = res.json().get('detail') or {}
    except ValueError:
        detail = {}
    check('提交被 402 拦下（余额 0 不建单）', res.status_code == 402, f'{res.status_code} {res.text[:160]}')
    check(
        '402 detail 是小程序付款码提示读的结构',
        detail.get('code') == 'insufficient_balance' and all(key in detail for key in ('cost', 'balance', 'sheets', 'message')),
        json.dumps(detail, ensure_ascii=False)[:200],
    )
    check('没有因 402 建出任务', requests.get(f'{BASE}/api/jobs/mine', headers=headers, timeout=20).json().get('jobs') == [])

    print('\n[4] 未登录访问（小程序登录页会先看本地令牌，令牌无效就跳登录）')
    res = requests.get(f'{BASE}/api/jobs/mine', timeout=20)
    check('无令牌访问任务列表返回 401', res.status_code == 401, str(res.status_code))

    print(f'\n结果：{passed} 项通过，{failed} 项失败（探针账号 {username}，余额 0，未建任何任务）')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
