# -*- coding: utf-8 -*-
"""虚拟打印机用例（临时脚本，不算交付代码）。

覆盖：
  1. 配置模块（truthy / 默认值 / 存取 / 监听目标）
  2. 真机网站链路：模拟打印 → 转 PDF → 提交 → 网站上出现「待审核」任务 → 扣费正确
  3. 配送方式/地址：配置留空 → 跟随网站「我的配置」；配送但没地址 → 提前给出可操作的提示
  4. 令牌缓存（第二次提交不重新登录）、余额不足 402、密码错、服务器连不上（重试后失败）
  5. CUPS 后端（macOS/Linux 的数据入口）：用 Git Bash 的 sh 实跑后端脚本 → 边车元数据 → 提交，
     并用「份数 2」验证按打印对话框里的份数计费
  6. PostScript 转换失败路径（没装 Ghostscript 时给的是「请安装 Ghostscript」而不是乱码）
  7. Windows 落盘文件监听：写文件 → 稳定后复制 → 提交；守护进程重启不重复提交
  8. 开机自启动开关（真写 HKCU Run 注册表，测完还原）
  9. 配置界面（真开 Tk 窗口，只是 withdraw 掉）：回显 / 保存 / 状态刷新 / 自启勾选
 10. 托盘图标生成、--status / --selftest / --once / --simulate

注意：登录接口有 10 次/分钟/IP 的限速（backend/main.py 的 _login_hits），所以开头先等
61 秒把限速窗口腾干净，整个用例里登录次数控制在 6 次以内（其余全部走缓存令牌）。

跑法： backend\\.venv\\Scripts\\python.exe .tmp-test\\vprinter_test.py
"""

from __future__ import annotations

import io
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VP_DIR = ROOT / "vprinter"

# 清掉上次失败留下的临时目录
for stale in Path(tempfile.gettempdir()).glob("vp-test-*"):
    shutil.rmtree(stale, ignore_errors=True)
HOME = Path(tempfile.mkdtemp(prefix="vp-test-"))
SPOOL = HOME / "spool" / "ANTIPRINT.pdf"

# 这两个环境变量必须在 import vprinter 之前设好（vp_config 在导入时算目录常量）
os.environ["ANTIPRINT_VPRINTER_HOME"] = str(HOME / "home")
os.environ["ANTIPRINT_VPRINTER_SPOOL"] = str(SPOOL)
os.environ["ANTIPRINT_VPRINTER_DESKTOP"] = str(HOME / "假桌面")   # 快捷方式别写到用户真实桌面
sys.path.insert(0, str(VP_DIR))

import requests                                                              # noqa: E402

import vp_config
from vp_api import ApiError, Client                                          # noqa: E402
from vp_config import (                                                      # noqa: E402
    CONFIG_PATH, FAILED_DIR, INBOX_DIR, SENT_DIR, load_config, load_recent,
    save_config, truthy, watch_targets,
)
from vp_pipeline import (                                                    # noqa: E402
    ConvertError, Pipeline, _read_sidecar, resolve_delivery, sanitize_name, to_pdf,
)
from vp_platform import (                                                    # noqa: E402
    autostart_command, autostart_enabled, platform_label, set_autostart,
)
import vp_platform                                                           # noqa: E402
import virtual_printer                                                       # noqa: E402

BASE = "http://127.0.0.1:8301"
ADDRESS = "测试楼 101（虚拟打印机用例）"
SAMPLE = ROOT / ".tmp-test" / "test-print.pdf"
CUPS_BACKEND = VP_DIR / "install" / "cups-backend-antiprint"

PASS = 0
FAIL = 0
LOGINS = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  [OK  ] {name}" + (f" — {detail}" if detail else ""))
    else:
        FAIL += 1
        print(f"  [FAIL] {name}" + (f" — {detail}" if detail else ""))


def section(title: str) -> None:
    print(f"\n== {title} ==")


def req(method: str, path: str, token: str = "", **kwargs):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    resp = requests.request(method, BASE + path, headers=headers, timeout=30, **kwargs)
    try:
        return resp.status_code, resp.json()
    except ValueError:
        return resp.status_code, {}


def login_as(cfg: dict) -> str:
    """显式登录一次并把令牌写进配置（用例里尽量少登录，避免踩限速）"""
    global LOGINS
    LOGINS += 1
    client = Client(cfg)
    token = client.login()
    cfg.update(client.cfg)
    return token


def my_jobs(token: str) -> list[dict]:
    return req("GET", "/api/jobs/mine", token)[1].get("jobs", [])


def submit(cfg: dict, name: str, title: str = "") -> "object":
    """往收件箱丢一份 PDF 并走一遍提交流程"""
    pipeline = Pipeline(cfg)
    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    dest = INBOX_DIR / f"{name}.pdf"
    shutil.copy2(SAMPLE, dest)
    return pipeline.process(dest, {"title": title or name})


def user_cfg(**overrides) -> dict:
    """主账号配置（带缓存令牌）：用例里一律用它，别用 load_config()——
    Client.login() 会把当前配置写回磁盘，切换账号的那几步会污染磁盘上的那份。"""
    return dict(USER_CFG, **overrides)


# ------------------------------------------------------------------ 前置

print(f"虚拟打印机用例（{platform_label()}，临时目录 {HOME}）")
print("等 61 秒清空登录限速窗口（10 次/分钟）…")
time.sleep(61)

status, health = req("GET", "/api/health")
assert status == 200 and health.get("db") == "ok", f"后端没就绪：{health}"

cache = ROOT / ".tmp-test" / ".admin-token.json"
ADMIN = ""
try:
    ADMIN = json.loads(cache.read_text(encoding="utf-8")).get("token") or ""
except (OSError, ValueError):
    pass
if not ADMIN or req("GET", "/api/settings", ADMIN)[0] != 200:
    LOGINS += 1
    ADMIN = req("POST", "/api/login", json={"username": "admin", "password": "admin123"})[1]["token"]
    cache.write_text(json.dumps({"token": ADMIN, "ts": int(time.time() * 1000)}), encoding="utf-8")

STAMP = str(int(time.time()))[-6:]
USER = f"vptest{STAMP}"
USER0 = f"vptest0{STAMP}"
for name in (USER, USER0):
    code, data = req("POST", "/api/register", json={"username": name, "password": "vptest123"})
    assert code == 200, f"注册 {name} 失败：{code} {data}"
users = req("GET", "/api/users", ADMIN)[1].get("users", [])
USER_ID = next(u["id"] for u in users if u["username"] == USER)
USER0_ID = next(u["id"] for u in users if u["username"] == USER0)
print(f"测试账号：{USER}（充 5 元 + 0.1 元，id={USER_ID}）、{USER0}（id={USER0_ID}）")

cfg = {
    "server": BASE, "auth_mode": "local", "username": USER, "password": "vptest123",
    "delivery_mode": "配送", "address": ADDRESS, "note": "虚拟打印机用例", "copies": 1,
    "printer_name": vp_config.DEFAULT_PRINTER_NAME, "watch_dirs": [], "paused": False, "autostart": False,
    "token": "", "token_at": 0.0, "token_user": "",
}
save_config(cfg)
TOKEN = login_as(cfg)                       # 登录 1 次，之后所有用例都吃缓存
USER_CFG = dict(cfg, token=TOKEN, token_at=time.time())
save_config(USER_CFG)
code, _ = req("POST", f"/api/users/{USER_ID}/balance", ADMIN, json={"delta": "5", "note": "虚拟打印机用例"})
assert code == 200, f"充值失败：{code}"

# ------------------------------------------------------------------ 1. 配置

section("1. 配置与工具")
check("truthy 按项目约定解析 '0'/'1'", truthy("0") is False and truthy("1") is True and truthy(0) is False)
check("sanitize_name 去掉非法字符", sanitize_name('报告: 2026/09*?.pdf') == "报告_ 2026_09_.pdf",
      sanitize_name('报告: 2026/09*?.pdf'))
check("配置写入 + 读回", load_config()["username"] == USER and CONFIG_PATH.exists(), str(CONFIG_PATH))
check("默认监听目标 = 平台默认落盘路径",
      [str(p) for p in watch_targets(user_cfg())] == [str(SPOOL)], str(watch_targets(user_cfg())))
check("自定义 watch_dirs 生效", watch_targets(user_cfg(watch_dirs=[str(HOME / "cups")])) == [HOME / "cups"])

section("1c. 打印机队列名（驼峰 + 版本号）")
check("队列名 = 驼峰品牌名 + 版本号", vp_config.DEFAULT_PRINTER_NAME == f"AntiPrint-{vp_config.VERSION}",
      vp_config.DEFAULT_PRINTER_NAME)
check("名字里没有空格（CUPS 队列名不允许空格）", " " not in vp_config.DEFAULT_PRINTER_NAME)
_saved_spool_env = os.environ.pop("ANTIPRINT_VPRINTER_SPOOL", None)   # 临时去掉覆盖，看默认推导
try:
    _derived = vp_config.spool_file_for(vp_config.DEFAULT_PRINTER_NAME)
    check("落盘文件跟着队列名走", _derived.name == f"{vp_config.DEFAULT_PRINTER_NAME}.pdf", _derived.name)
    check("落盘目录就在程序旁边的数据目录里（不再是 ProgramData）",
          _derived.parent == vp_config.SPOOL_DIR and vp_config.SPOOL_DIR.parent == vp_config.CONFIG_DIR,
          f"{_derived.parent} ⊂ {vp_config.CONFIG_DIR}")
    check("实例锁也在数据目录里（LOCALAPPDATA 那边不再留东西）",
          vp_config.LOCK_FILE.parent == vp_config.CONFIG_DIR, str(vp_config.LOCK_FILE))
    check("老落盘位置（ProgramData）只留作清理用",
          "ProgramData" in str(vp_config.LEGACY_SPOOL_DIR)
          and vp_config.LEGACY_SPOOL_DIR != vp_config.SPOOL_DIR, str(vp_config.LEGACY_SPOOL_DIR))
finally:
    if _saved_spool_env is not None:
        os.environ["ANTIPRINT_VPRINTER_SPOOL"] = _saved_spool_env
check("自检/测试用的环境变量覆盖仍然优先（用例自身就靠它隔离）",
      vp_config.spool_file_for("随便什么").name == Path(_saved_spool_env).name, vp_config.spool_file_for("随便什么").name)
check("老的全大写名字在「要清理」的名单里", "ANTIPRINT" in vp_config.LEGACY_PRINTER_NAMES,
      str(vp_config.LEGACY_PRINTER_NAMES))
save_config(dict(user_cfg(), printer_name="ANTIPRINT"))      # 模拟从 1.0.0 之前升上来的老配置
check("老配置里的 ANTIPRINT 自动升成新名字", load_config()["printer_name"] == vp_config.DEFAULT_PRINTER_NAME,
      load_config()["printer_name"])
save_config(dict(user_cfg(), printer_name="我的队列"))          # 用户自己起的名字不要动
check("用户自定义的队列名不动", load_config()["printer_name"] == "我的队列", load_config()["printer_name"])
save_config(user_cfg())

section("1b. 配送方式解析（配置留空 → 跟随网站「我的配置」）")
profile_full = {"default_delivery": "配送", "default_address": "图书馆二楼服务台"}
check("配置里留空 → 用网站默认的配送方式与地址",
      resolve_delivery({"delivery_mode": "", "address": ""}, profile_full) == ("配送", "图书馆二楼服务台", ""))
check("配置里填了 → 以配置为准",
      resolve_delivery({"delivery_mode": "取件", "address": "带地址也没关系"}, profile_full) == ("取件", "带地址也没关系", ""))
check("取件单不需要地址",
      resolve_delivery({"delivery_mode": "取件", "address": ""}, {"default_delivery": "取件"})[2] == "")
mode, address, problem = resolve_delivery({"delivery_mode": "", "address": ""}, {"default_delivery": "配送"})
check("配送但哪儿都没地址 → 提前给出可操作的提示（不白跑一趟 400）",
      mode == "配送" and not address and "我的配置" in problem and "取件" in problem, problem)

# ------------------------------------------------------------------ 2. 模拟打印 → 网站任务

section("2. 模拟打印：转 PDF → 提交 → 网站上出现待审核任务")
pipeline = Pipeline(user_cfg())
events: list[tuple[str, str]] = []
pipeline.notify = lambda kind, text: events.append((kind, text))
dest = INBOX_DIR / "sim-test.pdf"
shutil.copy2(SAMPLE, dest)
result = pipeline.process(dest, {"title": "test-print", "source": "simulate"})
check("提交成功", result.ok and result.job_id > 0, result.message)
check("扣费 0.10 元（1 张）", result.charge == "0.10", f"charge={result.charge} balance={result.balance}")
check("文件归档到 sent/", (SENT_DIR / "sim-test.pdf").exists())
check("最近记录里有一条成功", (load_recent() or [{}])[0].get("ok") is True)
check("托盘提示回调被调用", any(kind == "ok" for kind, _ in events), str(events[:1]))

jobs = my_jobs(TOKEN)
job = next((j for j in jobs if j["id"] == result.job_id), None)
check("网站上能查到该任务且状态=待审核", bool(job) and job["status"] == "待审核", job and job["status"])
check("任务文件名 = 上传时的名字", bool(job) and job["files"][0]["filename"] == "test-print.pdf",
      job and job["files"][0]["filename"])
check("任务备注带来源", bool(job) and job["note"] == "虚拟打印机用例", job and job["note"])
check("任务计费入账 charge=0.10", bool(job) and float(job["charge"]) == 0.10, job and str(job["charge"]))
code, info = req("GET", "/api/balance", TOKEN)
check("余额从 5.00 扣到 4.90", float(info["balance"]) == 4.90, str(info["balance"]))
check("登录令牌已缓存到配置里", bool(load_config().get("token")), load_config().get("token_user"))

# ------------------------------------------------------------------ 3. 令牌复用与失败路径

section("3. 令牌复用 / 跟随网站默认地址 / 余额不足 / 密码错 / 服务器连不上")
pipeline = Pipeline(user_cfg())
pipeline.client.login = lambda *a, **k: (_ for _ in ()).throw(AssertionError("不应重新登录"))
dest = INBOX_DIR / "sim-token.pdf"
shutil.copy2(SAMPLE, dest)
second = pipeline.process(dest, {"title": "第二次"})
check("缓存令牌可用：第二次提交没有重新登录", second.ok, second.message)

# USER0：网站上设好默认配送方式与地址，配置里留空 → 应当跟随网站默认值
USER0_CFG = dict(USER_CFG, username=USER0, token="", token_at=0.0)
TOKEN0 = login_as(USER0_CFG)                # 登录 2 次（这一步会把 USER0 的配置写进磁盘）
save_config(USER_CFG)                       # 把磁盘上的配置还原成主账号那份
zero_cfg = dict(USER_CFG, username=USER0, token=TOKEN0, token_at=time.time(),
                delivery_mode="", address="")
req("PUT", "/api/profile", TOKEN0, json={"default_delivery": "配送", "default_address": "图书馆二楼服务台"})
req("POST", f"/api/users/{USER0_ID}/balance", ADMIN, json={"delta": "0.1", "note": "虚拟打印机用例"})
follow = submit(zero_cfg, "sim-follow", "跟随默认")
check("配置留空的单子提交成功（跟随网站默认地址）", follow.ok, follow.message)
if follow.ok:
    followed = next(j for j in my_jobs(TOKEN0) if j["id"] == follow.job_id)
    check("任务用的就是网站里的默认配送方式与地址",
          followed["delivery_mode"] == "配送" and followed["address"] == "图书馆二楼服务台",
          f"{followed['delivery_mode']} / {followed['address']}")

req("PUT", "/api/profile", TOKEN0, json={"default_delivery": "配送", "default_address": ""})
no_addr = submit(zero_cfg, "sim-noaddr", "没地址")
check("配送但没地址：给出「去哪儿改」的提示而不是裸 400",
      (not no_addr.ok) and "我的配置" in no_addr.message, no_addr.message)
check("没地址的单子进了 failed/", any(FAILED_DIR.glob("sim-noaddr*")))
check("最近记录标记为「缺配送地址」", (load_recent() or [{}])[0].get("kind") == "缺配送地址",
      str((load_recent() or [{}])[0].get("kind")))

poor = submit(dict(zero_cfg, delivery_mode="取件"), "sim-poor", "余额不足")
check("余额 0 提交被拒（402）且没有建单",
      (not poor.ok) and "余额不足" in poor.message and poor.job_id == 0, poor.message)
check("最近记录标记为「余额不足」", (load_recent() or [{}])[0].get("kind") == "余额不足")
check("余额 0 的账号没有被扣款", float(req("GET", "/api/balance", TOKEN0)[1]["balance"]) == 0.0)

bad = submit(user_cfg(password="肯定不对的密码", token="", token_at=0), "sim-badpw", "密码错")
check("密码错：提示用户名或密码错误且不抛出异常",
      (not bad.ok) and "用户名或密码错误" in bad.message, f"{bad.message}（本次共登录 {LOGINS} 次）")

dead = submit(user_cfg(server="http://127.0.0.1:1", token="", token_at=0), "sim-dead", "连不上")
check("服务器连不上：重试后失败并给出提示",
      (not dead.ok) and "连不上服务器" in dead.message, dead.message)

# ------------------------------------------------------------------ 4. CUPS 后端

section("4. CUPS 后端脚本（macOS/Linux 的打印数据入口）")
cups_spool = HOME / "cups"
cups_spool.mkdir(parents=True, exist_ok=True)
sh = shutil.which("sh")
check("找得到 sh（Git Bash）", bool(sh), sh or "")
if sh:
    done = subprocess.run(
        [sh, str(CUPS_BACKEND), "7", USER, "季度报告.docx", "2", "media=A4", str(SAMPLE)],
        env=dict(os.environ, ANTIPRINT_SPOOL=str(cups_spool)), capture_output=True, timeout=60,
    )
    check("后端退出码 0", done.returncode == 0, done.stderr.decode("utf-8", "ignore")[:120])
    jobs_in_spool = [p for p in cups_spool.glob("job-*") if p.suffix != ".json"]
    check("后端写出了一条打印数据", len(jobs_in_spool) == 1, str([p.name for p in jobs_in_spool]))
    if jobs_in_spool:
        check("后端按内容识别出 PDF（.pdf 后缀）", jobs_in_spool[0].suffix == ".pdf", jobs_in_spool[0].name)
        sidecar = jobs_in_spool[0].with_suffix(".json")
        meta = _read_sidecar(sidecar) if sidecar.exists() else {}
        check("边车元数据记录了打印标题/用户/份数",
              meta.get("title") == "季度报告.docx" and meta.get("user") == USER and meta.get("copies") == "2",
              json.dumps(meta, ensure_ascii=False))
        cups_cfg = user_cfg(watch_dirs=[str(cups_spool)], copies=1)
        handled = Pipeline(cups_cfg).run_once()
        check("守护进程取走并提交了 CUPS 任务", handled == 1, f"处理 {handled} 个")
        check("收件目录已清空", not list(cups_spool.glob("job-*")))
        latest = my_jobs(TOKEN)[0]
        check("上传的文件名 = 打印标题（.docx 换成 .pdf）", latest["files"][0]["filename"] == "季度报告.pdf",
              latest["files"][0]["filename"])
        check("按打印对话框里的份数 2 计费（0.20 元）", float(latest["charge"]) == 0.20,
              f"charge={latest['charge']}")

        section("5. PostScript 数据 → PDF 转换")
        # 本机到底能不能转，用同一条转换器链实测（有的 ps2pdf 只是包装器，跑完啥也不产出）
        probe = HOME / "probe.ps"
        probe.write_bytes(b"%!PS-Adobe-3.0\n%%Pages: 1\nshowpage\n%%EOF\n")
        try:
            to_pdf(probe, HOME / "probeout")
            can_convert = True
        except ConvertError:
            can_convert = False
        print(f"  （本机 PS→PDF 实测：{'可以转换' if can_convert else '转不了（缺 Ghostscript）'}）")
        # 转换器分支按「去扩展名的小写名字」判定：Windows 上 which 回来的是 ps2pdf.EXE，
        # 拿 name 跟 "ps2pdf" 比会落进最后那条 macOS convert 分支 —— 命令行变成
        # `ps2pdf in.ps -o out.pdf`，于是**当前目录**多出一个叫 `-o` 的文件、真输出反而没生成
        # （2026-09-16 实测踩到）。这里换个「当前目录」再跑一遍，验分支判定且不丢垃圾文件。
        cwd_probe = HOME / "cwd-probe"
        cwd_probe.mkdir(exist_ok=True)
        saved_cwd = os.getcwd()
        os.chdir(cwd_probe)
        try:
            to_pdf(probe, HOME / "probeout2")
            same_result = True
        except ConvertError:
            same_result = False
        finally:
            os.chdir(saved_cwd)
        check("换到别的当前目录，转换结果与刚才一致（分支判定没串）", same_result == can_convert,
              f"第一次 {'成功' if can_convert else '失败'}、第二次 {'成功' if same_result else '失败'}")
        check("转换过程不会在当前目录乱丢文件（那个叫 -o 的）", not (cwd_probe / "-o").exists(),
              "目录内容：" + (", ".join(p.name for p in cwd_probe.iterdir()) or "空"))
        (cups_spool / "job-20260915-010101-abcd.ps").write_bytes(
            b"%!PS-Adobe-3.0\n%%Pages: 1\nshowpage\n%%EOF\n")
        time.sleep(0.6)      # 守护进程对刚出现的文件有 0.4 秒的等待
        pipeline = Pipeline(cups_cfg)
        handled = pipeline.run_once()
        text = pipeline.last_result.message if pipeline.last_result else ""
        if can_convert:
            check("PS 被转成 PDF 并提交", pipeline.last_result.ok, text)
            # 提交用的必须是「转换后那个 PDF」：转换产物会先从 _work/ 移到 inbox/，
            # 再拿旧路径去打开就是 FileNotFoundError（2026-09-16 踩到，原来是 `submit_job(pdf)`）
            check("转换后的 PDF 进了 sent/，原件没有被反复重试",
                  any(p.suffix == ".pdf" for p in SENT_DIR.glob("*")) and not list(INBOX_DIR.glob("*.ps")),
                  "sent/：" + (", ".join(p.name for p in SENT_DIR.glob("*")) or "空"))
            work_left = list((INBOX_DIR / "_work").glob("*")) if (INBOX_DIR / "_work").is_dir() else []
            check("转换产物不会留在 _work/ 里（提交完就清空）", not work_left,
                  [p.name for p in work_left] or "空")
        else:
            check("转不了时明确提示装 Ghostscript，而不是乱码/崩掉",
                  (not pipeline.last_result.ok) and "Ghostscript" in text, text)
            check("失败原因写清楚（没生成文件 / 输出不是 PDF / 退出码）",
                  any(word in text for word in ("没有生成文件", "输出不是 PDF", "退出码")), text)
        check("PS 文件已被归档（不会反复重试）", not list(cups_spool.glob("job-*.ps")), f"处理 {handled} 个")

# ------------------------------------------------------------------ 6b. 真守护进程端到端

section("6b. 真起一个守护进程：打印文件 → 它自己提交（端到端）")
daemon_log = HOME / "daemon.out"
before = len(my_jobs(TOKEN))
daemon = subprocess.Popen(
    [sys.executable, str(VP_DIR / "virtual_printer.py"), "--no-tray"],
    # NO_GUI=1：不然守护进程会因为「队列还没装」把配置界面弹出来，用例跑完留一堆窗口
    env=dict(os.environ, ANTIPRINT_VPRINTER_HOME=str(HOME / "home"),
             ANTIPRINT_VPRINTER_SPOOL=str(SPOOL), ANTIPRINT_VPRINTER_NO_GUI="1"),
    stdout=daemon_log.open("wb"), stderr=subprocess.STDOUT,
)
try:
    time.sleep(3.5)
    SPOOL.parent.mkdir(parents=True, exist_ok=True)
    SPOOL.write_bytes(SAMPLE.read_bytes())        # 相当于用户在打印对话框里点了打印
    deadline = time.time() + 20
    detected = False
    while time.time() < deadline:
        if len(my_jobs(TOKEN)) > before:
            detected = True
            break
        time.sleep(1)
    check("守护进程自己在几秒内把落盘的文件提交了", detected,
          f"任务数 {before} → {len(my_jobs(TOKEN))}")
    check("守护进程日志没有报错", "ERROR" not in daemon_log.read_text(encoding="utf-8", errors="replace"),
          daemon_log.read_text(encoding="utf-8", errors="replace")[-200:])
    second_daemon = subprocess.run(
        [sys.executable, str(VP_DIR / "virtual_printer.py"), "--no-tray"],
        env=dict(os.environ, ANTIPRINT_VPRINTER_HOME=str(HOME / "home"),
                 ANTIPRINT_VPRINTER_SPOOL=str(SPOOL)),
        capture_output=True, timeout=60,
    )
    check("单实例锁生效：第二个守护进程拒绝启动并按 1 退出", second_daemon.returncode == 1,
          second_daemon.stdout.decode("utf-8", "ignore").strip()[:60])
finally:
    daemon.terminate()
    try:
        daemon.wait(timeout=10)
    except subprocess.TimeoutExpired:
        daemon.kill()

# ------------------------------------------------------------------ 7. Windows 落盘文件

section("7. Windows 落盘文件监听（驱动写文件 → 复制 → 提交，重启不重复）")
SPOOL.parent.mkdir(parents=True, exist_ok=True)
if SPOOL.exists():
    SPOOL.unlink()
pipeline = Pipeline(user_cfg(watch_dirs=[]))
pipeline.run_once()
shutil.copy2(SAMPLE, SPOOL)
before = len(my_jobs(TOKEN))
for _ in range(4):
    pipeline.run_once()
    time.sleep(0.7)
after = my_jobs(TOKEN)
check("写进落盘文件后自动提交了一份", len(after) == before + 1, f"{before} → {len(after)}")
if len(after) > before:
    check("落盘文件仍保留（驱动下次要重写它，我们只复制不搬走）", SPOOL.exists())
    check("落盘文件那一版已被记住（状态文件存在）", (HOME / "home" / "spool_state.json").exists())

restarted = Pipeline(user_cfg(watch_dirs=[]))
restarted.run_once()
restarted.run_once()
check("守护进程重启后不会把同一份重复提交", len(my_jobs(TOKEN)) == len(after),
      f"{len(after)} → {len(my_jobs(TOKEN))}")

# ------------------------------------------------------------------ 7b. 单实例：占锁 + 接管

section("7b. 单实例锁被占时：说清楚 + 能接管（升级场景）")
busy_home = HOME / "busy-home"
busy_home.mkdir(parents=True, exist_ok=True)
save_config(dict(user_cfg(), printer_name=vp_config.DEFAULT_PRINTER_NAME))    # 先让主配置就位
import shutil as _shutil                                                     # noqa: E402

_shutil.copy2(CONFIG_PATH, busy_home / "config.json")
busy_env = dict(os.environ, ANTIPRINT_VPRINTER_HOME=str(busy_home),
                ANTIPRINT_VPRINTER_SPOOL=str(HOME / "busy.pdf"), ANTIPRINT_VPRINTER_NO_GUI="1")
holder = subprocess.Popen([sys.executable, str(VP_DIR / "virtual_printer.py"), "--no-tray"],
                          env=busy_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(3.5)
    check("旧实例活着（占着锁）", holder.poll() is None, f"exit={holder.poll()}")
    from vp_platform import SingleInstance, other_instance_pids   # noqa: E402

    probe = SingleInstance(busy_home / "vprinter.lock")
    check("第二个实例拿不到锁", probe.acquire() is False)
    found = other_instance_pids()
    check("能认出「别的实例」（不包含自己，也不是要杀自己）", len(found) >= 1, str(found))
    # 用例里**不能**调 stop_other_instances()：它按进程名匹配（产品里用途是「升级时接管旧副本」，
    # 有用户确认），会把用户正在跑的实例一起停掉 —— 2026-09-16 真的误杀过一次。
    # 这里只停「本用例自己起的那个」，验的是「持有者退出后锁会被释放」这个机制。
    holder_pids = {holder.pid, holder.pid + 1}       # venv 启动器 + 真正跑程序的那个
    for pid in holder_pids:
        subprocess.run(["powershell", "-NoProfile", "-Command",
                        f"Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue"],
                       capture_output=True, timeout=30)
    check("持有者被停掉后，锁能立刻被接管（产品里 handle_already_running 就是这个流程）", True,
          f"已停 PID {sorted(holder_pids)}")
    deadline = time.time() + 10
    got_lock = False
    while time.time() < deadline:
        if probe.acquire():
            got_lock = True
            break
        time.sleep(0.3)
    check("停掉之后能拿到锁（本次启动接管成功）", got_lock)
    _source = importlib.import_module("inspect").getsource(virtual_printer.handle_already_running)
    check("有控制台（命令行/管道）或 --silent 时只打印一句、不弹窗（自动化/开机不会被卡住）",
          "not windowless() or silent" in _source and "ask_yes_no" in _source,
          "见 handle_already_running()：只有窗口程序且非 silent 才可能弹窗")
    check("同一份程序再点一次 → 直接开配置界面（不再无意义地「接管 + 重启」）",
          "same_copy" in _source and "open_settings_window()" in _source,
          "双击 = 想看界面；只有「另一份副本在跑」才问接管")
    probe.release()
finally:
    holder.terminate()
    try:
        holder.wait(timeout=10)
    except subprocess.TimeoutExpired:
        holder.kill()

# ------------------------------------------------------------------ 8. 自启动

section("8. 开机自动启动开关")
original_autostart = autostart_enabled()
ok, message = set_autostart(True)
check("勾选自启：写入成功", ok, message)
check("自启命令指向 virtual_printer.py、用 pythonw、带 --silent（开机不主动弹界面）",
      "virtual_printer.py" in autostart_command() and "pythonw" in autostart_command().lower()
      and autostart_command().rstrip().endswith("--silent"),
      autostart_command())
if os.name == "nt":
    import winreg
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
        value, _ = winreg.QueryValueEx(key, "AntiPrintVPrinter")
    check("注册表 HKCU\\...\\Run 里有 AntiPrintVPrinter", "virtual_printer.py" in value, value)
ok, message = set_autostart(False)
check("取消自启：删除成功", ok and not autostart_enabled(), message)
if original_autostart:
    set_autostart(True)
    print("  （原本就是开启状态，已还原）")

# ------------------------------------------------------------------ 9. 配置界面

section("9. 配置界面（Tk 真窗口，仅 withdraw 不显示）")
try:
    import tkinter as tk
    from vp_gui import SettingsWindow

    save_config(dict(load_config(), username="换个人试试", password="vptest123", copies=1,
                     delivery_mode="", address=""))
    root = tk.Tk()
    root.withdraw()
    window = SettingsWindow(root)
    root.update()
    check("界面用网站 logo 当图标（顶部那张）",
          window.icon_photo is not None and window.icon_photo.width() == 44,
          f"{window.icon_photo.width()}x{window.icon_photo.height()}" if window.icon_photo else "（没有图标）")
    footer = window.footer                       # 界面自己留了引用，别去猜行号（曾因此 IndexError 整段被跳过）
    footer_buttons = [child.cget("text") for child in window.footer_row.winfo_children()
                      if child.winfo_class() == "TButton"]
    check("底部操作条固定在窗口内、「保存并应用」不用滚动就能点到",
          footer.winfo_y() + footer.winfo_height() <= root.winfo_height()
          and footer.winfo_rooty() > window.page_area.winfo_rooty()
          and "保存并应用" in footer_buttons,
          " / ".join(footer_buttons) + f"（操作条底边 {footer.winfo_y()+footer.winfo_height()} ≤ 窗口高 {root.winfo_height()}）")
    check("底部两行都不超宽（7 个控件挤一行会盖住勾选项，这是用户反馈过的「遮挡」）",
          all(sum(c.winfo_reqwidth() for c in row.winfo_children()) + 6 * len(row.winfo_children())
              <= root.wm_minsize()[0]
              for row in (window.footer_row, window.footer_checks)),
          f"最小窗口宽 {root.wm_minsize()[0]}px："
          + " / ".join(f"{label} {sum(c.winfo_reqwidth() for c in row.winfo_children()) + 6 * len(row.winfo_children())}px"
                       for label, row in (("按钮行", window.footer_row), ("勾选行", window.footer_checks))))
    check("界面分成子界面：三个二级菜单按钮",
          [button.cget("text") for button in window.tab_buttons.values()] == ["网站账号", "提交选项", "运行状态"],
          str([button.cget("text") for button in window.tab_buttons.values()]))
    window._show_tab("submit")
    root.update()
    cells = {(page.grid_info()["row"], page.grid_info()["column"]) for page in window.pages.values()}
    check("点二级菜单能切子界面（三页叠在同一格、靠 raise 切换；选中按钮变品牌色）",
          window.active_tab == "submit" and len(cells) == 1
          and window.tab_buttons["submit"].cget("style") == "TabActive.TButton"
          and window.tab_buttons["account"].cget("style") == "Tab.TButton",
          f"{window.active_tab} / 同一格={len(cells) == 1} / {window.tab_buttons['submit'].cget('style')}")
    check("分栏之后窗口矮了（≤620 高，之前 770）",
          root.winfo_height() <= 620 and root.winfo_height() > 300, f"{root.winfo_width()}x{root.winfo_height()}")
    window._show_tab("account")
    root.update()
    check("打开时回显了用户名/服务器",
          window.var_user.get() == "换个人试试" and window.var_server.get() == BASE,
          f"{window.var_user.get()} @ {window.var_server.get()}")
    check("配送方式回显「跟随网站默认」", window.var_delivery.get() == "跟随网站默认", window.var_delivery.get())
    window.var_user.set(USER)
    window.var_delivery.set("取件")
    window.var_address.set("图书馆一楼自助打印点")
    window.var_copies.set(3)
    check("界面上的「提交后弹窗提示」默认勾上（默认弹窗）", window.var_notify.get() is True,
          f"var_notify={window.var_notify.get()}")
    window.var_notify.set(True)          # 勾上，随保存一起写进配置
    window.var_note.set("来自虚拟打印机")
    window._save()
    root.update()
    saved = load_config()
    check("保存后配置落盘（用户名 / 取件 / 3 份 / 备注 / 弹窗开关）",
          saved["username"] == USER and saved["delivery_mode"] == "取件"
          and saved["copies"] == 3 and saved["note"] == "来自虚拟打印机"
          and saved["notify_popup"] is True,
          json.dumps({k: saved[k] for k in ("username", "delivery_mode", "copies", "note", "notify_popup")},
                     ensure_ascii=False))
    check("保存时换了账号会清掉旧令牌", saved["token"] == "")
    window._refresh_status()
    root.update()
    check("状态区能显示队列/收件目录信息", vp_config.DEFAULT_PRINTER_NAME in window.lbl_status.cget("text"),
          window.lbl_status.cget("text").replace("\n", " | ")[:120])
    window.var_autostart.set(True)
    window._toggle_autostart()
    root.update()
    check("界面勾选自启真的写了系统自启项", autostart_enabled())
    window.var_autostart.set(False)
    window._toggle_autostart()
    root.destroy()
    check("界面取消勾选后自启项已移除", not autostart_enabled())
except Exception as exc:
    print(f"  [SKIP] 无法开 Tk 窗口：{exc}")

# ------------------------------------------------------------------ 10. 托盘 / CLI

section("10. 图标（与网站 logo 同款）与命令行")
from vp_tray import BRAND, CLAY, TRAY_AVAILABLE, load_logo, logo_source, make_image   # noqa: E402

check("pystray/Pillow 可用（托盘图标能显示）", TRAY_AVAILABLE)
check("图标取自网站那份 logo（frontend/public/apple-touch-icon.png）",
      "apple-touch-icon.png" in str(logo_source()), str(logo_source()))
image = load_logo(64)
check("图标是 64×64 的 RGBA 位图", image.size == (64, 64) and image.mode == "RGBA", f"{image.size} {image.mode}")
check("徽标底色是品牌青绿 #4a9d9a", image.getpixel((6, 20))[:3] == BRAND, str(image.getpixel((6, 20))))
check("缺角是透明的（圆角方块）", image.getpixel((0, 0))[3] == 0)
check("中间是白色的打印机描边（网站用 same 图标）", max(image.getpixel((32, 26))[:3]) > 200,
      str(image.getpixel((32, 26))))
site = Path("frontend/public/apple-touch-icon.png")
if site.is_file():
    from PIL import Image as _PILImage                                             # noqa: E402

    site_small = _PILImage.open(site).convert("RGBA").resize((64, 64), _PILImage.LANCZOS)
    diff = sum(1 for a, b in zip(site_small.getdata(), image.getdata()) if a != b)
    check("与网站 logo 逐像素一致（改网站图标后 app 图标自动跟着变）", diff == 0, f"差异 {diff}/4096 像素")
error = load_logo(64, "error")
check("失败态：同一形状换成警示色砖红", error.getpixel((6, 20))[:3] == CLAY
      and max(error.getpixel((32, 26))[:3]) > 200, str(error.getpixel((6, 20))))
fallback = make_image(BRAND, 64)
check("兜底图标仍可用（拿不到网站 logo 时才用）",
      fallback.size == (64, 64) and fallback.getpixel((5, 20))[:3] == BRAND)
check("默认服务器 = 线上站点", load_config()["server"] == "https://print.anticraft.top"
      or vp_config.DEFAULT_SERVER == "https://print.anticraft.top", vp_config.DEFAULT_SERVER)

section("10b. 托盘菜单回调（不起消息循环，直接调用菜单项）")
import threading                                                            # noqa: E402
from vp_tray import Tray                                                    # noqa: E402

stop_event = threading.Event()
tray = Tray(Pipeline(user_cfg()), stop_event)
menu_texts = [str(item.text) for item in tray._menu().items if item.text]
check("菜单里有安装/卸载队列、打开配置界面/收件目录/重试失败/暂停/自启/退出",
      all(any(key in text for text in menu_texts) for key in
          ("卸载虚拟打印机队列", "打开配置界面", "收件目录", "重试失败", "暂停监听", "开机自动启动", "退出"))
      and any(("安装虚拟打印机队列" in text or "修复虚拟打印机队列" in text) for text in menu_texts),
      " | ".join(menu_texts))
check("菜单里有「打开数据目录」（绿色模式一眼看到数据在哪）",
      any("打开数据目录" in text for text in menu_texts))
check("菜单里有「提交后弹窗提示」开关", any("提交后弹窗提示" in text for text in menu_texts))
tray.notify("ok", "提交成功")                # icon 还没建（没起消息循环），不能崩
check("提交结果会更新状态文字", "提交成功" in tray.status_text, tray.status_text)

section("10a2. 桌面快捷方式（可选，免 Python 用户最需要的入口）")
from vp_platform import create_desktop_shortcut, desktop_dir, shortcut_exists, shortcut_path   # noqa: E402

_fake_desktop = HOME / "假桌面"
check("出厂默认：没问过要不要快捷方式", vp_config.DEFAULT_CONFIG["shortcut_asked"] is False)
check("环境变量能指定桌面目录（测试不动真实桌面）",
      desktop_dir() == _fake_desktop, str(desktop_dir()))
check("还没创建时 shortcut_exists 为假", shortcut_exists(_fake_desktop) is False)
_ok, _message = create_desktop_shortcut(_fake_desktop)
check("创建桌面快捷方式", _ok and shortcut_path(_fake_desktop).exists(), _message)
check("创建后 shortcut_exists 为真", shortcut_exists(_fake_desktop) is True)

section("10b1. 端口与本程序目录不一致时的护栏")
from vp_platform import queue_port, spool_mismatch                              # noqa: E402

_printer = vp_config.DEFAULT_PRINTER_NAME
_expected = vp_config.spool_file_for(_printer)
_actual = queue_port(_printer)
_same = (not _actual) or os.path.normcase(_actual) == os.path.normcase(str(_expected))
check("spool_mismatch 的定义：端口指别处才提示（本目录一致就返回空）",
      (spool_mismatch(_printer) == "") if _same else (spool_mismatch(_printer) == _actual),
      f"队列端口={_actual or '（未装队列）'} ｜ 期望={_expected} ｜ 提示={spool_mismatch(_printer)!r}")

section("10b2. 托盘图标真的加进托盘了（打桩 Shell_NotifyIcon）")
# 2026-09-16 的教训：pystray 的 run(setup=…) 一旦传了回调，它就不再执行默认那句
# `visible = True`，图标永远不会被 NIM_ADD 加进托盘 —— 而回调里记的「已显示」日志照写不误，
# 看上去像系统把图标弄丢了。所以这里直接给 Shell_NotifyIcon 打桩，断言消息真的发出且成功。
import pystray._win32 as _w32                                                  # noqa: E402

from vp_pipeline import Pipeline as _Pipeline                                  # noqa: E402

_calls: list[tuple[int, bool]] = []
_original_notify = _w32.win32.Shell_NotifyIcon


def _spy(code, data):
    result = _original_notify(code, data)
    _calls.append((int(code), bool(result)))
    return result


_w32.win32.Shell_NotifyIcon = _spy
_probe_stop = threading.Event()
_tray_probe = Tray(_Pipeline(user_cfg()), _probe_stop)
_tray_probe.set_state("ok", "用例探针")
threading.Thread(target=lambda: (time.sleep(6), _tray_probe._quit()), daemon=True).start()
try:
    _tray_probe.run()
except SystemExit as exc:                        # 没有图形环境时会走 --no-tray 那条路
    _w32.win32.Shell_NotifyIcon = _original_notify
    print(f"  [SKIP] 托盘不可用：{exc}")
else:
    _w32.win32.Shell_NotifyIcon = _original_notify
    adds = [ok for code, ok in _calls if code == _w32.win32.NIM_ADD]
    deletes = [ok for code, ok in _calls if code == _w32.win32.NIM_DELETE]
    check("托盘图标调用了 Shell_NotifyIcon(NIM_ADD)", bool(adds), f"调用序列 {_calls}")
    check("NIM_ADD 被系统接受（这才是「图标显示出来了」的真凭据）",
          bool(adds) and all(adds), f"NIM_ADD 返回值 {adds}")
    check("退出时会调 NIM_DELETE 把图标撤掉", bool(deletes), f"NIM_DELETE {deletes}")
    check("托盘就绪标志 ready 为真", _tray_probe.ready is True)

section("10c. 弹窗提示开关（默认不弹）")
check("出厂默认：提交后弹窗（勾选状态下才弹）", vp_config.DEFAULT_CONFIG["notify_popup"] is True)
save_config(dict(load_config(), notify_popup=False))     # 前面界面用例把它勾上过，这里先归位
tray.pipeline.update_config(load_config())
check("新配置读出来也是 False", load_config().get("notify_popup") is False)


class _FakeIcon:
    def __init__(self):
        self.calls: list[tuple] = []

    def notify(self, *args):
        self.calls.append(args)


tray.icon = _FakeIcon()
tray.notify("ok", "默认不弹窗")
check("开关关闭时：不发气泡，但图标状态与悬停文字照常更新",
      not tray.icon.calls and "默认不弹窗" in tray.status_text, tray.status_text)
tray._toggle_notify()                      # 菜单里勾上
check("勾上后配置落盘 + 流水线热更新", load_config()["notify_popup"] is True
      and tray.pipeline.cfg.get("notify_popup") is True)
tray.notify("ok", "现在会弹了")
check("开关打开时：气泡发出", len(tray.icon.calls) == 1 and tray.icon.calls[0][0] == "现在会弹了",
      str(tray.icon.calls))
tray._toggle_notify()
check("再点一次回到不弹", load_config()["notify_popup"] is False and not tray.icon.calls[1:])
tray.icon = None
tray.set_state("error", "提交失败")
check("失败态切到警示色", tray.state == "error" and tray.status_text == "提交失败")
tray._toggle_pause()
check("菜单「暂停监听」写进配置并热更新到流水线",
      load_config()["paused"] is True and tray.pipeline.paused is True)
tray._toggle_pause()
check("再点一次恢复监听", load_config()["paused"] is False and tray.pipeline.paused is False)
(HOME / "home" / "failed").mkdir(parents=True, exist_ok=True)
shutil.copy2(SAMPLE, HOME / "home" / "failed" / "x.pdf")
tray._retry_failed()
check("菜单「重试失败的文件」把文件挪回收件箱",
      (HOME / "home" / "inbox" / "x.pdf").exists(), str(tray.status_text))
tray._quit()
check("菜单「退出」会通知守护进程收工", stop_event.is_set())
for leftover in (HOME / "home" / "inbox").glob("*"):        # 别让后面 --once 把它们又提交一遍
    if leftover.is_file():
        shutil.move(str(leftover), str(HOME / "home" / "failed" / leftover.name))

save_config(dict(load_config(), token=TOKEN, token_at=time.time(),
                 watch_dirs=[str(HOME / "empty")]))
(HOME / "empty").mkdir(exist_ok=True)
buffer = io.StringIO()
with redirect_stdout(buffer):
    code = virtual_printer.main(["--status"])
payload = json.loads(buffer.getvalue())
check("--status 输出可解析的 JSON 且列出队列/监听目录",
      code == 0 and payload["队列"]["名称"] == vp_config.DEFAULT_PRINTER_NAME and "监听目标" in payload,
      json.dumps(payload["队列"], ensure_ascii=False))
check("--status 报告守护进程未运行（用例里没起常驻）", payload["守护进程"] is False)

buffer = io.StringIO()
with redirect_stdout(buffer):
    code = virtual_printer.main(["--once"])
check("--once 正常退出", code == 0, buffer.getvalue().strip())

buffer = io.StringIO()
with redirect_stdout(buffer):
    code = virtual_printer.main(["--selftest"])
text = buffer.getvalue()
check("--selftest 逐项给结论（退出码 0=关键项通过、1=有关键问题）",
      code in (0, 1) and "服务器登录" in text and "虚拟打印机队列" in text,
      (text.strip().splitlines()[-1] if text.strip() else ""))
check("--selftest 对队列给出「已安装/未安装」结论", "已安装" in text or "未安装" in text)
check("--selftest 会把「端口还指着老位置」报成关键问题（输出与该状态一致）",
      ("落盘文件" in text) == (spool_mismatch(vp_config.DEFAULT_PRINTER_NAME) != ""),
      "本机端口状态：" + (spool_mismatch(vp_config.DEFAULT_PRINTER_NAME) or "与本目录一致"))

buffer = io.StringIO()
with redirect_stdout(buffer):
    code = virtual_printer.main(["--simulate", str(SAMPLE)])
text = buffer.getvalue()
check("--simulate 走通整条链路（按配置里的 3 份计费）", code == 0 and "成功" in text, text.strip()[:140])
latest = my_jobs(TOKEN)
if latest:
    check("--simulate 提交的是 3 份（0.30 元）", float(latest[0]["charge"]) == 0.30, str(latest[0]["charge"]))

# ------------------------------------------------------------------ 10b. 退出程序

section("10b. 退出：配置界面窗口一起关掉，守护进程不受影响")
# 配置界面是另一个进程（关窗口不影响后台服务），所以「退出」必须主动去关它 ——
# 2026-09-16 用户反馈「托盘图标关闭后程序没有真正关闭」就是窗口还留在屏幕上。
# 这里验两条：① 关得掉（含启动器父/子两个进程）；② 绝不误杀守护进程。
quit_daemon = subprocess.Popen(
    [sys.executable, str(VP_DIR / "virtual_printer.py"), "--no-tray"],
    env=dict(os.environ, ANTIPRINT_VPRINTER_HOME=str(HOME / "home"),
             ANTIPRINT_VPRINTER_SPOOL=str(SPOOL), ANTIPRINT_VPRINTER_NO_GUI="1"),
    stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
)
try:
    time.sleep(3)
    vp_platform.spawn_settings_window()
    time.sleep(2.5)
    window_pids = vp_platform.settings_window_pids()
    check("能认出开着的配置界面窗口进程（按命令行里的 --settings）", len(window_pids) >= 1, str(window_pids))
    check("认出的窗口里不含守护进程自己", quit_daemon.pid not in window_pids,
          f"守护 pid={quit_daemon.pid}，窗口={window_pids}")
    killed = vp_platform.close_settings_windows()
    time.sleep(1.5)
    check("退出会把配置界面窗口（含启动器父子进程）一起关干净",
          killed >= 1 and vp_platform.settings_window_pids() == [], f"停掉 {killed} 个")
    check("关窗口不会误杀守护进程（它得继续监听打印任务）", quit_daemon.poll() is None)
finally:
    quit_daemon.terminate()
    try:
        quit_daemon.wait(timeout=10)
    except subprocess.TimeoutExpired:
        quit_daemon.kill()
    # terminate() 只杀得掉 venv 启动器，真正跑程序的子进程会留着（守卫进程会一直轮询）——
    # 按形态收窄过的 stop_daemon() 正好只停「源码形态」的守护，不会碰用户那份分发包实例
    if vp_platform.stop_daemon():
        time.sleep(1)

# ------------------------------------------------------------------ 10c. 关窗口：只关界面 / 退出程序

section("10c. 点窗口的 ×：默认询问、可记住、可改回（只关界面不动后台服务）")
import tkinter as tk                                                         # noqa: E402

import vp_gui                                                                # noqa: E402

check("出厂默认：点 × 时「每次询问」", vp_config.DEFAULT_CONFIG["close_action"] == "ask",
      vp_config.DEFAULT_CONFIG["close_action"])
save_config({**load_config(), "close_action": "乱写的值"})
check("配置里手写成别的值 → 读回来兜成「每次询问」", load_config()["close_action"] == "ask",
      load_config()["close_action"])


def window_alive(root) -> bool:
    try:
        return bool(root.winfo_exists())
    except tk.TclError:
        return False


def new_settings_window(action: str):
    """开一个真配置界面（withdraw 掉，不弹到屏幕上）"""
    save_config({**load_config(), "close_action": action})
    root = tk.Tk()
    root.withdraw()
    return root, vp_gui.SettingsWindow(root)


close_daemon = subprocess.Popen(
    [sys.executable, str(VP_DIR / "virtual_printer.py"), "--no-tray"],
    env=dict(os.environ, ANTIPRINT_VPRINTER_HOME=str(HOME / "home"),
             ANTIPRINT_VPRINTER_SPOOL=str(SPOOL), ANTIPRINT_VPRINTER_NO_GUI="1"),
    stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
)
try:
    time.sleep(3)
    check("后台服务在跑（下面要验 × 的选择对它的影响）", bool(vp_platform.daemon_pids()),
          str(vp_platform.daemon_pids()))

    # ①「运行状态」页能改这个设置，改完立刻落盘
    root, window = new_settings_window("ask")
    check("「运行状态」页有三个选项（每次询问 / 只关界面 / 退出程序）", len(window.close_radios) == 3,
          f"{len(window.close_radios)} 个")
    window.var_close.set("window")
    window._set_close_action()
    check("页面上改成「只关界面」立刻落盘", load_config()["close_action"] == "window",
          load_config()["close_action"])
    check("改完有提示说明后果", "后台服务继续" in window.lbl_hint.cget("text"), window.lbl_hint.cget("text"))
    window.root.destroy()

    # ② 选「只关界面」：窗口关掉、后台服务照旧
    root, window = new_settings_window("window")
    window._on_close()
    check("选「只关界面」：窗口关了", not window_alive(root))
    check("选「只关界面」：后台服务不受影响", close_daemon.poll() is None and bool(vp_platform.daemon_pids()),
          f"守护进程 {vp_platform.daemon_pids()}")

    # ③ 默认「每次询问」：弹窗里点「取消」→ 窗口留着
    asked: list = []

    class StubPrompt(tk.Toplevel):
        """假装用户在弹窗里点了某个按钮（真 Toplevel，wait_window 才等得住）"""

        def __init__(self, master, remember_default=False):
            super().__init__(master)
            self.withdraw()
            asked.append(remember_default)
            self.result, remember = answers.pop(0)
            self.remember = tk.BooleanVar(value=remember)
            self.after(60, self.destroy)

    vp_gui.ClosePrompt = StubPrompt
    answers = [(None, False)]
    root, window = new_settings_window("ask")
    window._on_close()
    check("弹窗里点「取消」：窗口不关（不会误退程序）",
          window_alive(root) and close_daemon.poll() is None, f"问了 {len(asked)} 次")
    root.destroy()

    # ④ 弹窗里选「退出程序」并勾「记住我的选择」→ 停后台服务 + 落盘
    answers = [("quit", True)]
    root, window = new_settings_window("ask")
    window._on_close()
    time.sleep(2)
    check("弹窗里选「退出程序」：后台服务真的停了（进程没了）",
          close_daemon.poll() is not None and not vp_platform.daemon_pids(),
          f"守护进程 {vp_platform.daemon_pids()}")
    check("弹窗里选「退出程序」：窗口也关了", not window_alive(root))
    check("勾了「记住我的选择」→ 落盘", load_config()["close_action"] == "quit",
          load_config()["close_action"])

    # ⑤ 记住之后不再问：再来一次直接把窗口关掉（不该再多一次询问）
    before_asks = len(asked)
    root, window = new_settings_window("quit")
    window._on_close()
    check("记住之后不再询问（× 直接照记住的办）", len(asked) == before_asks and not window_alive(root),
          f"询问次数 {before_asks} → {len(asked)}")
finally:
    if close_daemon.poll() is None:
        close_daemon.terminate()
        try:
            close_daemon.wait(timeout=10)
        except subprocess.TimeoutExpired:
            close_daemon.kill()
    vp_platform.stop_daemon()              # 收尾：把本形态的守护进程停干净（别留给后面几节）
    save_config({**load_config(), "close_action": "ask"})     # 别把「退出程序」留给后面的用例

# ------------------------------------------------------------------ 10d. 三个跟「改完就生效」有关的行为

section("10d. 托盘勾选跟着配置文件走 + 手动启动自动开配置界面 + 两个开关勾了即存")

# ① 托盘菜单里的勾选状态：用户反馈「配置界面改了，托盘还显示改之前的」
#    —— 菜单回调原来读内存里那份（要等 2 秒热更新），现在改成现读配置文件
menu_tray = Tray(None, threading.Event())
menu_items = {str(item.text): item for item in menu_tray._menu() if item.text and str(item.text) != "- - - - "}


def checked_of(label: str):
    # pystray 的 MenuItem.checked 是**属性**（读的时候就调那个回调、拿到当前值），不是回调本身
    return bool(menu_items[label].checked)


before = truthy(load_config().get("notify_popup"))
cfg = load_config()
cfg["notify_popup"] = not before
save_config(cfg)
check("托盘菜单「提交后弹窗提示」的勾选立刻跟着配置文件变（不用等热更新）",
      checked_of("提交后弹窗提示") != before, f"磁盘上 {before} → {not before}，菜单读到 {checked_of('提交后弹窗提示')}")
cfg["notify_popup"] = before
save_config(cfg)
check("改回去也一样（菜单读到的是磁盘上的当前值）",
      checked_of("提交后弹窗提示") == before, f"菜单读到 {checked_of('提交后弹窗提示')}")
check("托盘菜单「开机自动启动」读的是系统真实状态",
      checked_of("开机自动启动") == autostart_enabled(), f"菜单 {checked_of('开机自动启动')} / 系统 {autostart_enabled()}")

# ①b 匹配规则只认「本程序这一形态」：源码里跑用例/调试时不能碰到用户那份分发包实例
#     （2026-09-17 踩过：用例里的「退出程序」把用户正在跑的生产实例一起停了）
saved_frozen = vp_platform.IS_FROZEN
check("源码形态只匹配 python 跑 virtual_printer 的进程（不会碰到 AntiPrintVPrinter.exe）",
      "AntiPrintVPrinter.exe" not in vp_platform._daemon_match()
      and "virtual_printer" in vp_platform._daemon_match(), vp_platform._daemon_match().strip()[:70])
vp_platform.IS_FROZEN = True
check("exe 形态只匹配 AntiPrintVPrinter.exe（源码进程不误伤）",
      "AntiPrintVPrinter.exe" in vp_platform._daemon_match()
      and "AntiPrintVPrinter.exe" in vp_platform._settings_match(), vp_platform._settings_match().strip()[:70])
vp_platform.IS_FROZEN = saved_frozen

# ② 手动启动（双击 exe / 快捷方式）要顺手把配置界面打开；自启动与自动化不弹
check("手动启动（有托盘、不是 --silent）→ 会打开配置界面", virtual_printer.wants_settings_window(False, True))
check("开机自启（--silent）→ 不打开配置界面", not virtual_printer.wants_settings_window(True, True))
check("无托盘模式（--no-tray，自动化走这条）→ 不打开", not virtual_printer.wants_settings_window(False, False))
os.environ["ANTIPRINT_VPRINTER_NO_GUI"] = "1"
check("设了 NO_GUI（自动化/无界面）→ 不打开", not virtual_printer.wants_settings_window(False, True))
os.environ.pop("ANTIPRINT_VPRINTER_NO_GUI")

# 真起一个「双击式」守护进程（无参数、带托盘）：日志里应写明「手动启动」并真的开出窗口
manual = subprocess.Popen(
    [sys.executable, str(VP_DIR / "virtual_printer.py")],
    env=dict(os.environ, ANTIPRINT_VPRINTER_HOME=str(HOME / "home"),
             ANTIPRINT_VPRINTER_SPOOL=str(SPOOL)),
    stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
)
try:
    deadline = time.time() + 30
    opened: list[int] = []
    while time.time() < deadline:
        opened = vp_platform.settings_window_pids()
        if opened:
            break
        time.sleep(1)
    check("双击式启动确实把配置界面开了出来", bool(opened), f"窗口进程 {opened or '无'}")
    manual_log = (HOME / "home" / "log" / "vprinter.log").read_text(encoding="utf-8", errors="replace")
    check("日志写明这是「手动启动」（不是首次引导）", "手动启动：打开配置界面" in manual_log,
          "\n".join(line for line in manual_log.splitlines() if "配置界面" in line)[-160:])
finally:
    vp_platform.close_settings_windows()
    manual.terminate()
    try:
        manual.wait(timeout=10)
    except subprocess.TimeoutExpired:
        manual.kill()
    vp_platform.stop_daemon()

# ③ 底部两个勾选框：勾了立刻落盘（用户要求，不用再按「保存并应用」）
root, window = new_settings_window("ask")
window.var_notify.set(not truthy(load_config().get("notify_popup")))
window._toggle_notify()
check("「提交后弹窗提示」勾选后立刻落盘", truthy(load_config().get("notify_popup")) == bool(window.var_notify.get()),
      f"配置里 {load_config().get('notify_popup')}")
check("勾完有提示（不用再点保存）", "已保存" in window.lbl_hint.cget("text"), window.lbl_hint.cget("text"))
window.var_autostart.set(autostart_enabled())        # 设成当前系统状态：净变化为零，不动用户系统
window._toggle_autostart()
check("「开机自动启动」勾选后立刻落盘", load_config()["autostart"] == autostart_enabled(),
      f"配置里 {load_config().get('autostart')}")
check("两个勾选框都挂了即存回调（不再依赖「保存并应用」）",
      bool(window.chk_notify.cget("command")) and bool(window.chk_autostart.cget("command")))
window.root.destroy()

# ------------------------------------------------------------------ 收尾

section("收尾：清理用例创建的任务")
# 按提交人名字清理（比记 id 靠谱：中途自动重试提交的任务也一起清掉）
removed = failed = 0
for item in req("GET", "/api/jobs", ADMIN)[1].get("jobs", []):
    if not str(item.get("username") or "").startswith("vptest"):
        continue
    code, _ = req("DELETE", f"/api/jobs/{item['id']}", ADMIN)
    removed += 1 if code == 200 else 0
    failed += 0 if code == 200 else 1
print(f"  已删除 {removed} 个测试任务（失败 {failed} 个；删任务会自动退费；登录共 {LOGINS} 次）")
shutil.rmtree(HOME, ignore_errors=True)

print(f"\n结果：{PASS} 项通过，{FAIL} 项失败")
sys.exit(1 if FAIL else 0)
