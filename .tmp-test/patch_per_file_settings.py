"""一次性补丁：打印设置下沉到「每个文件一套」（后端 + 代理）——临时脚本，执行后可删。

改动：
- main.py：POST /api/jobs 接受 `settings`（JSON 数组，与 files 顺序一一对应），逐项校验后写进各文件；
  任务出参里每个文件的 print_options 解析成 dict（job 级仍是默认值/兼容旧客户端）。
- agent_api.py：代理领取时每个文件带上自己的 print_options。
- print_agent.py：按「文件 → 任务 → 全局」优先级取该文件的打印设置。
"""
import pathlib

# ── main.py ──
p = pathlib.Path("backend/main.py")
s = p.read_text(encoding="utf-8")

# 1) 端点签名加 settings
old_sig = '''    copies: str = Form(default="1"),
    paper: str = Form(default=""),'''
new_sig = '''    copies: str = Form(default="1"),
    settings: str = Form(default=""),
    paper: str = Form(default=""),'''
assert old_sig in s
s = s.replace(old_sig, new_sig, 1)

# 2) 解析 settings（JSON 数组，与上传文件顺序对齐）
anchor = '''    options = _build_print_options(paper, pages, nup, scale)
    options["copies"] = copies_value'''
add = anchor + '''
    # 每个文件可以有自己的打印设置：settings 是 JSON 数组，顺序与 files 一一对应；
    # 某一项为空对象时该文件沿用任务级默认（上面的 options）。
    file_settings: list[dict] = []
    if (settings or "").strip():
        try:
            raw_settings = json.loads(settings)
        except ValueError:
            raise HTTPException(status_code=400, detail="打印设置格式不正确")
        if not isinstance(raw_settings, list):
            raise HTTPException(status_code=400, detail="打印设置格式不正确")
        seen_options: dict[str, dict] = {}
        for item in raw_settings:
            if not isinstance(item, dict):
                raise HTTPException(status_code=400, detail="打印设置格式不正确")
            key = json.dumps(item, sort_keys=True, ensure_ascii=False)
            if key not in seen_options:
                one = _build_print_options(
                    str(item.get("paper") or ""), str(item.get("pages") or ""),
                    str(item.get("nup") or ""), str(item.get("scale") or ""),
                )
                try:
                    file_copies = int(str(item.get("copies") or copies_value))
                except ValueError:
                    raise HTTPException(status_code=400, detail="份数必须是整数")
                if not 1 <= file_copies <= constants.PRINT_COPIES_MAX:
                    raise HTTPException(status_code=400, detail=f"份数需在 1~{constants.PRINT_COPIES_MAX} 之间")
                one["copies"] = file_copies
                seen_options[key] = one
            file_settings.append(seen_options[key])'''
assert anchor in s
s = s.replace(anchor, add, 1)

# 3) 落盘时把每个文件的设置挂到 saved 条目上（按上传顺序对齐；重复文件跳过时其设置一并跳过）
old_loop = '''        for item in uploads:'''
new_loop = '''        for index, item in enumerate(uploads):'''
assert old_loop in s
s = s.replace(old_loop, new_loop, 1)

old_saved = '''            saved.append({'''
new_saved = '''            saved.append({'''
s = s.replace(old_saved, new_saved, 1)

# 在 saved.append 之后附上该文件的设置（找到 append 块的结尾）
old_append = '''                "sha256": digest,
            })'''
new_append = '''                "sha256": digest,
                # 该文件自己的打印设置（没传 settings 时为空，代理回落到任务级默认）
                "print_options": (
                    json.dumps(file_settings[index], ensure_ascii=False)
                    if index < len(file_settings) and file_settings[index] else None
                ),
            })'''
assert old_append in s
s = s.replace(old_append, new_append, 1)

# 4) 任务出参：文件级 print_options 解析成 dict
old_payload = '''def _job_payload(job):
    """任务出参：把 print_options 从 JSON 文本解析成 dict（前端/代理直接可用）"""
    if not job:
        return job
    payload = dict(job)
    payload["print_options"] = _parse_print_options(job.get("print_options"))
    return payload'''
new_payload = '''def _job_payload(job):
    """任务出参：任务级与**每个文件**的 print_options 都从 JSON 文本解析成 dict"""
    if not job:
        return job
    payload = dict(job)
    payload["print_options"] = _parse_print_options(job.get("print_options"))
    payload["files"] = [
        {**item, "print_options": _parse_print_options(item.get("print_options"))}
        for item in (job.get("files") or [])
    ]
    return payload'''
assert old_payload in s
s = s.replace(old_payload, new_payload, 1)

# 5) 日志带上「每文件设置数」
s = s.replace('"用户 %s 提交任务 #%s（%s 个文件，%s，份数 %s，打印设置 %s，地址：%s）",',
              '"用户 %s 提交任务 #%s（%s 个文件，%s，份数 %s，任务级设置 %s，逐文件设置 %s 条，地址：%s）",', 1)
s = s.replace('user["username"], job["id"], len(saved), mode, copies_value, options, address or "（取件）",',
              'user["username"], job["id"], len(saved), mode, copies_value, options, len(file_settings), address or "（取件）",', 1)

p.write_text(s, encoding="utf-8")
print("main.py：已支持逐文件打印设置（settings 数组 + 出参解析）")

# ── agent_api.py：代理领取时每个文件带自己的设置 ──
a = pathlib.Path("backend/agent_api.py")
t = a.read_text(encoding="utf-8")
old_files = '''            for item in job.get("files", [])
        ],
    }'''
new_files = '''            for item in job.get("files", [])
        ],
    }


# 上面的 files 循环里补上每个文件的打印设置（文件级优先，任务级作兜底，代理自己决定优先级）'''
assert old_files in t
t = t.replace(old_files, new_files, 1)
t = t.replace('''                "url": f"/api/agent/jobs/{job['id']}/files/{item['id']}",''',
              '''                "url": f"/api/agent/jobs/{job['id']}/files/{item['id']}",
                "print_options": _parse_options(item.get("print_options")),''', 1)
a.write_text(t, encoding="utf-8")
print("agent_api.py：代理领取的文件项已带 print_options")

# ── print_agent.py：逐文件取设置（文件 → 任务 → 全局）──
g = pathlib.Path("agent/print_agent.py")
u = g.read_text(encoding="utf-8")
old_call = "            ok, error = self.print_file(local_path, copies, options)"
new_call = "            ok, error = self.print_file(local_path, file_copies, file_options)"
assert old_call in u
u = u.replace(old_call, new_call, 1)
old_loop = '''        for index, item in enumerate(files, start=1):'''
if old_loop not in u:
    old_loop = '''        for index, item in enumerate(files, start=1):'''
anchor2 = "        for index, item in enumerate(files, start=1):"
if anchor2 in u:
    u = u.replace(anchor2, '''        for index, item in enumerate(files, start=1):
            # 每个文件可以有各自的打印设置：文件级 → 任务级 → 全局默认
            file_options = item.get("print_options") or options or {}
            try:
                file_copies = int(
                    file_options.get("copies") or item.get("copies") or copies or 1
                )
            except (TypeError, ValueError):
                file_copies = copies''', 1)
g.write_text(u, encoding="utf-8")
print("print_agent.py：已按文件取打印设置")
