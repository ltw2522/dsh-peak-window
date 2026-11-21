# -*- coding: utf-8 -*-
"""把 issue #542 正文里的「暂未附截图」段替换成三张图（raw 直链），token 只经环境变量。"""
import json
import os
import urllib.error
import urllib.request

API = "https://api.github.com"
REPO = "polang233/dsh-plugin-index"
ISSUE = 542
BASE = "https://raw.githubusercontent.com/ltw2522/dsh-peak-window/issue542-shots/docs/issue542"
TOKEN = os.environ["GH_TOKEN"]


def call(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", "token " + TOKEN)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "dsh-agent")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


OLD = """### 插件实际效果 / Plugin screenshots

暂未附截图（可按需补充）。插件会出现在「设置 → 峰时守卫」页与输入框右侧工具栏。"""

NEW = f"""### 插件实际效果 / Plugin screenshots

**峰时（工作日 09:00–12:00、14:00–18:00）点发送先弹确认卡**：`继续`=放行、`返回`=退回并保留草稿。

![峰时确认卡]({BASE}/01-peak-confirm.png)

**谷时距峰时不足提前量时弹一次不阻断的提醒卡**：`本次不再提醒` = 整段谷时静音（直到进入峰时），`知道了` 只关本次。

![谷时提醒卡]({BASE}/02-valley-notice.png)

**设置 → 峰时守卫设置**：提前量、重复提醒与静音状态灰字说明（「本次不再提醒：HH:MM 进入峰时前不再弹出提醒卡」）、运行中提醒、回车发送拦截、放假安排自动更新。

![设置页]({BASE}/03-settings-muted.png)

> 截图在插件内置的「调试模式（仅本机）」下触发，卡片里的时间值（0h30m / 1h00m / 14:37）为模拟；界面元素与文案与真实触发完全一致。"""

st, body = call("GET", f"/repos/{REPO}/issues/{ISSUE}")
if st != 200:
    raise SystemExit(f"读取 issue 失败 {st}: {body[:200]}")
cur = json.loads(body)["body"]
if OLD not in cur:
    print("[skip] 正文已不含「暂未附截图」原文，未修改")
else:
    st, body = call("PATCH", f"/repos/{REPO}/issues/{ISSUE}", {"body": cur.replace(OLD, NEW)})
    print("[patch]", st, body[:160].decode("utf-8", "replace"))
