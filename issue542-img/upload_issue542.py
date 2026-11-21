# -*- coding: utf-8 -*-
"""
把 issue #542 的三张截图上传到插件仓库的分支 issue542-shots（不动 main），
再在 polang233/dsh-plugin-index#542 下补一条 1.2.6 评论引用 raw 图片。

用法（token 只经环境变量传入，不落盘）：
    set GH_TOKEN=ghp_xxx && python upload_issue542.py

幂等：已存在的同名文件会用新内容覆盖；评论里带隐藏标记，重复运行不会重复发。
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.github.com"
REPO = "ltw2522/dsh-peak-window"          # 图片存放仓库（自己的仓库）
INDEX_REPO = "polang233/dsh-plugin-index"  # issue 所在仓库
ISSUE = 542
BRANCH = "issue542-shots"
DIR_IN_REPO = "docs/issue542"
MARKER = "<!-- dsh-peak-window-shot-126 -->"  # 评论幂等标记

HERE = os.path.dirname(os.path.abspath(__file__))
IMAGES = [
    ("01-peak-confirm.png", "峰时确认卡"),
    ("02-valley-notice.png", "谷时提醒卡"),
    ("03-settings-muted.png", "设置页静音行"),
    ("01b-peak-card-zoom.png", "峰时卡特写"),
    ("02b-valley-card-zoom.png", "谷时卡特写"),
]

TOKEN = os.environ.get("GH_TOKEN", "").strip()


def call(method: str, path: str, payload=None):
    """统一封装 GitHub REST 调用，返回 (status, body_bytes)。"""
    url = path if path.startswith("http") else API + path
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
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


def ensure_branch():
    """分支不存在时从默认分支建出来（ref 不存在返回 422）。"""
    st, body = call("GET", f"/repos/{REPO}/git/ref/heads/{BRANCH}")
    if st == 200:
        print(f"[branch] {BRANCH} 已存在")
        return
    st, body = call("GET", f"/repos/{REPO}")
    base = json.loads(body)["default_branch"]
    st, body = call("GET", f"/repos/{REPO}/git/ref/heads/{base}")
    sha = json.loads(body)["object"]["sha"]
    st, body = call("POST", f"/repos/{REPO}/git/refs",
                    {"ref": f"refs/heads/{BRANCH}", "sha": sha})
    print(f"[branch] 新建 {BRANCH} from {base}@{sha[:7]} -> {st}")
    if st not in (200, 201):
        raise SystemExit(f"建分支失败: {st} {body[:300]}")


def upload(name: str) -> str:
    """按 Contents API 上传单文件，返回 raw 直链。"""
    path = f"{DIR_IN_REPO}/{name}"
    src = os.path.join(HERE, name)
    b64 = base64.b64encode(open(src, "rb").read()).decode("ascii")
    # 已存在则带上 sha 覆盖
    st, body = call("GET", f"/repos/{REPO}/contents/{path}?ref={BRANCH}")
    payload = {"message": f"docs: issue542 截图 {name}", "branch": BRANCH, "content": b64}
    if st == 200:
        payload["sha"] = json.loads(body)["sha"]
    st, body = call("PUT", f"/repos/{REPO}/contents/{path}", payload)
    if st not in (200, 201):
        raise SystemExit(f"上传 {name} 失败: {st} {body[:300]}")
    raw = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/{path}"
    print(f"[upload] {name} ({os.path.getsize(src)/1024:.1f} KB) -> {st} {raw}")
    return raw


def main():
    if not TOKEN:
        raise SystemExit("缺少 GH_TOKEN 环境变量")
    ensure_branch()
    urls = {name: upload(name) for name, _ in IMAGES}

    body = MARKER + "\n".join([
        "已更新到 `dsh-peak-window@1.2.6`（npm latest 已是 1.2.6，2026-11-18 14:03 上线）。",
        "",
        "1.2.5 把「本次不再提醒」改成**整段谷时静音**，但设置页灰字与按钮悬停说明仍显示旧文案——原因是界面文案有两份："
        "`locale/*.json` 只给插件列表用，设置页与卡片读的是 `client.js` 内嵌的 `ZH`/`EN` 常量。"
        "1.2.6 把两份同步，并在 `test-guard.mjs` 加了文案断言（含旧文案反向断言），以后漏改会直接测试失败。",
        "",
        "### 实际效果",
        "",
        f"![峰时确认卡]({urls['01-peak-confirm.png']})",
        "",
        "峰时（工作日 09:00–12:00、14:00–18:00）点发送先弹确认卡：`继续`=放行、`返回`=退回并保留草稿，"
        "另有 `暂停，谷时自动恢复执行`。",
        "",
        f"![谷时提醒卡]({urls['02-valley-notice.png']})",
        "",
        "谷时距峰时不足设定提前量时弹一次不阻断的提醒卡：`本次不再提醒` = 整段谷时静音（直到进入峰时），`知道了` 只关本次。",
        "",
        f"![设置页]({urls['03-settings-muted.png']})",
        "",
        "设置 → 峰时守卫设置：提前量、重复提醒与静音状态灰字说明（「本次不再提醒：HH:MM 进入峰时前不再弹出提醒卡」）、"
        "运行中提醒、回车发送拦截、放假安排自动更新（数据源 NateScarlet/holiday-cn，MIT，仅 GET 公开 JSON）。",
        "",
        "> 说明：截图是在插件内置的「调试模式（仅本机）」下触发的，卡片里的 `0h30m` / `1h00m` / `14:37` 是模拟时间值，"
        "用于稳定复现各类卡片；界面元素、文案与真实触发时完全一致。",
        "",
        "- 仓库：https://github.com/ltw2522/dsh-peak-window",
        "- Release：https://github.com/ltw2522/dsh-peak-window/releases/tag/v1.2.6",
        "- npm：https://www.npmjs.com/package/dsh-peak-window",
    ])

    st, data = call("GET", f"/repos/{INDEX_REPO}/issues/{ISSUE}/comments")
    if st == 200 and any(MARKER in (c.get("body") or "") for c in json.loads(data)):
        print("[comment] 已存在同标记评论，跳过")
        return
    st, data = call("POST", f"/repos/{INDEX_REPO}/issues/{ISSUE}/comments", {"body": body})
    if st not in (200, 201):
        raise SystemExit(f"发评论失败: {st} {data[:300]}")
    print("[comment] 已发布:", json.loads(data)["html_url"])


if __name__ == "__main__":
    main()
