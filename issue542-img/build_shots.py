# -*- coding: utf-8 -*-
"""
issue #542 截图加工：
1) 三张原始整窗图（2560x1600，含 Windows 任务栏）→ 裁掉底部任务栏（y>=1528），保留 DSH 窗口全部边缘；
2) 等比缩放到宽 1600 px（GitHub issue 正文舒适宽度，单张 <1 MB）；
3) 另出两张卡片特写（2x 放大原像素裁切），便于审核人看清按钮文案。
输入为 DSH 会话附件（只读），输出写到 issue542-img/ 目录。
"""
import os
from PIL import Image

SRC = {
    # 峰时确认卡（红「继续」+ 灰「返回」+「暂停，谷时自动恢复执行」）
    "01-peak-confirm": r"C:\Users\lenovo\.dsh\attachments\v1\objects\29\29a9fc470df9b5f2bf448020cb4bd06af81b67c05a38d6317530d26b1de2d7bd",
    # 谷时提醒卡（「本次不再提醒」+「知道了」）
    "02-valley-notice": r"C:\Users\lenovo\.dsh\attachments\v1\objects\04\04fbebe176e347e0baa72d4b828d28fc9f769a0c6d81002b84a4a7e9c920a081",
    # 设置页（静音行灰字）
    "03-settings-muted": r"C:\Users\lenovo\.dsh\attachments\v1\objects\d9\d931e88cb36a7d7e0e040fc24dbb1402735ed801e3a570a4b8cd8c6133f31707",
}

# 实测：Windows 任务栏上沿在 y=1527（1528/1529 为任务栏描边），窗口横向占满 0..2560
CROP_TOP = 0
CROP_BOTTOM = 1528
CROP_LEFT = 0
CROP_RIGHT = 2560
TARGET_W = 1600

OUT_DIR = os.path.dirname(os.path.abspath(__file__))


def shrink(im: Image.Image, width: int) -> Image.Image:
    """按目标宽度等比缩放（LANCZOS 重采样，UI 文字边缘最干净）。"""
    ratio = width / im.width
    return im.resize((width, max(1, round(im.height * ratio))), Image.LANCZOS)


for name, path in SRC.items():
    im = Image.open(path).convert("RGB")
    win = im.crop((CROP_LEFT, CROP_TOP, CROP_RIGHT, CROP_BOTTOM))
    out = shrink(win, TARGET_W)
    dst = os.path.join(OUT_DIR, f"{name}.png")
    out.save(dst, "PNG", optimize=True, compress_level=9)
    print(f"{name}: {im.size} -> {win.size} -> {out.size}, {os.path.getsize(dst)/1024:.1f} KB")

# 卡片特写：只取右下角卡片区域，放大 2 倍便于阅读按钮文案
CARDS = {
    "01b-peak-card-zoom": (SRC["01-peak-confirm"], (2060, 1120, 2560, 1400)),
    "02b-valley-card-zoom": (SRC["02-valley-notice"], (2060, 1180, 2560, 1400)),
}
for name, (path, box) in CARDS.items():
    im = Image.open(path).convert("RGB").crop(box)
    out = im.resize((im.width * 2, im.height * 2), Image.LANCZOS)
    dst = os.path.join(OUT_DIR, f"{name}.png")
    out.save(dst, "PNG", optimize=True, compress_level=9)
    print(f"{name}: {im.size} -> {out.size}, {os.path.getsize(dst)/1024:.1f} KB")
