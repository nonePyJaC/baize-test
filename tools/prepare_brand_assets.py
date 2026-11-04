"""从品牌源图生成客户端内置素材。

源图（工作区根目录，由设计方提供）：
- logo.png      横向 logo（图形 + 白泽 + BAIZE）
- 图标icon.png  方形 App 图标（用于打包、桌面快捷方式等外部场景）

产出：
- src/assets/logo-baize.png  应用内展示用 logo：裁掉四周空白、底色归一为纯白（与界面白底融合）
- src/assets/icon-baize.png  应用内启动/兜底用方形图标

用法：python tools/prepare_brand_assets.py [源图目录]
"""

from pathlib import Path
import sys

from PIL import Image, ImageChops

REPO = Path(__file__).resolve().parents[1]
ASSETS = REPO / "src" / "assets"
LOGO_WIDTH = 640
ICON_SIZE = 256
BACKGROUND_TOLERANCE = 18
PADDING = 6


def normalize_background(image: Image.Image) -> Image.Image:
    """把近似白色的底归一为纯白，避免界面白底上出现淡淡的图片边框。"""
    rgb = image.convert("RGB")
    background = Image.new("RGB", rgb.size, rgb.getpixel((0, 0)))
    mask = ImageChops.difference(rgb, background).convert("L").point(lambda value: 255 if value > BACKGROUND_TOLERANCE else 0)
    white = Image.new("RGB", rgb.size, (255, 255, 255))
    return Image.composite(rgb, white, mask)


def build_logo(source: Path, target: Path) -> None:
    image = normalize_background(Image.open(source))
    background = Image.new("RGB", image.size, (255, 255, 255))
    content = ImageChops.difference(image, background).getbbox()
    if content:
        left, top, right, bottom = content
        image = image.crop((
            max(0, left - PADDING),
            max(0, top - PADDING),
            min(image.width, right + PADDING),
            min(image.height, bottom + PADDING),
        ))
    height = round(image.height * LOGO_WIDTH / image.width)
    image.resize((LOGO_WIDTH, height), Image.LANCZOS).save(target, optimize=True)
    print(f"{target.relative_to(REPO)} {image.width}x{image.height} -> {LOGO_WIDTH}x{height}")


def build_icon(source: Path, target: Path) -> None:
    image = Image.open(source).convert("RGBA")
    side = min(image.size)
    left = (image.width - side) // 2
    top = (image.height - side) // 2
    image.crop((left, top, left + side, top + side)).resize((ICON_SIZE, ICON_SIZE), Image.LANCZOS).save(target, optimize=True)
    print(f"{target.relative_to(REPO)} -> {ICON_SIZE}x{ICON_SIZE}")


def main() -> None:
    source_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO
    build_logo(source_dir / "logo.png", ASSETS / "logo-baize.png")
    build_icon(source_dir / "图标icon.png", ASSETS / "icon-baize.png")


if __name__ == "__main__":
    main()
