"""生成小程序地图标记图标（marker 必须有 iconPath，属于二进制资源）。

用法：
    python tools/gen_icons.py

生成的 PNG 会写入 miniprogram/images/，可重复执行覆盖。
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "miniprogram" / "images"
SCALE = 4  # 4 倍超采样后缩小，得到平滑边缘

TEAL = (18, 165, 148, 255)
TEAL_DARK = (13, 133, 120, 255)
ORANGE = (255, 122, 69, 255)
WHITE = (255, 255, 255, 255)
SHADOW = (17, 24, 39, 46)


def canvas(width: int, height: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new("RGBA", (width * SCALE, height * SCALE), (0, 0, 0, 0))
    return image, ImageDraw.Draw(image)


def finish(image: Image.Image, width: int, height: int) -> Image.Image:
    return image.resize((width, height), Image.LANCZOS)


def draw_pin(width: int, height: int, color: tuple[int, int, int, int], ring: tuple[int, int, int, int]) -> Image.Image:
    image, draw = canvas(width, height)
    w, h = width * SCALE, height * SCALE
    radius = w // 2
    head_bottom = h - int(h * 0.30)

    # 投影
    draw.ellipse(
        (w * 0.10 + 2 * SCALE, head_bottom * 0.92 + 3 * SCALE, w * 0.90 + 2 * SCALE, head_bottom + 3 * SCALE),
        fill=SHADOW,
    )
    # 针尖
    draw.polygon(
        [
            (int(w * 0.24), int(head_bottom * 0.86)),
            (int(w * 0.76), int(head_bottom * 0.86)),
            (w // 2, h - SCALE),
        ],
        fill=color,
    )
    # 圆头
    draw.ellipse((0, 0, w - 1, head_bottom), fill=color)
    # 内圈
    inner = int(radius * 0.42)
    cx, cy = w // 2, head_bottom // 2
    draw.ellipse((cx - inner, cy - inner, cx + inner, cy + inner), fill=ring)
    return finish(image, width, height)


def draw_cluster(size: int) -> Image.Image:
    image, draw = canvas(size, size)
    s = size * SCALE
    border = int(s * 0.07)
    draw.ellipse((0, 0, s - 1, s - 1), fill=SHADOW)
    draw.ellipse((border, border, s - 1 - border, s - 1 - border), fill=WHITE)
    draw.ellipse(
        (border * 2.2, border * 2.2, s - 1 - border * 2.2, s - 1 - border * 2.2), fill=TEAL
    )
    return finish(image, size, size)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    draw_pin(36, 48, TEAL, WHITE).save(OUT_DIR / "marker.png")
    draw_pin(36, 48, ORANGE, WHITE).save(OUT_DIR / "marker-active.png")
    draw_pin(44, 58, TEAL_DARK, WHITE).save(OUT_DIR / "pin-center.png")
    draw_cluster(64).save(OUT_DIR / "marker-cluster.png")

    for name in ("marker.png", "marker-active.png", "pin-center.png", "marker-cluster.png"):
        path = OUT_DIR / name
        print(f"生成 {path.relative_to(ROOT)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()

