#!/usr/bin/env python3
"""将生图的 3×2 Pinekin 素材表描摹为六张透明、分层的 SVG。

使用已有 Pillow 与 VTracer 0.6.15 环境，不向应用安装任何依赖。
输入图片仅用于转换；标准输出只含 JSON 统计，不输出图像数据。例如：

  /path/to/python -I /path/to/scripts/vectorize-empty-states.py \
    --source /path/to/design/illustrations/empty-states/source/pinekin-empty-states.png \
    --output-dir /path/to/src/renderer/src/assets/empty-states

只写入 --output-dir 下的 SVG。不写临时位图、不联网、不读取客户端，
也不使用手绘路径替代生图轮廓。
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import io
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter
    import vtracer
except ImportError as error:
    raise SystemExit(
        "缺少本地转换依赖：" + str(error)
        + "。请使用已有 Pillow 与 VTracer 环境；本脚本不会安装依赖。"
    ) from error

NAMESPACE = "http://www.w3.org/2000/svg"
STATES = (
    ("disconnected", "等待连接来源"),
    ("empty", "空文件盒"),
    ("search", "查找会话"),
    ("selection", "等待选择会话"),
    ("unavailable", "暂时无法读取"),
    ("messages", "还没有消息"),
)
# 沿用本地收纳插画的分色色板；陶土色不再限于耳部，可用于道具细节。
COLORS = ((255, 255, 255), (84, 78, 71), (244, 215, 175), (220, 159, 131))
LAYERS = (("paper", 0), ("apricot", 2), ("terracotta", 3), ("ink", 1))
SIZE = 512
CONTENT_SIZE = 400
# 沿用已确认插画的 1024px 描摹采样，保留细腻轮廓。
TRACE_SCALE = 2
RASTER_SIZE = SIZE * TRACE_SCALE
MEDIAN_FILTER = 3
PARAMETERS = {
    "colormode": "binary",
    "mode": "spline",
    "filter_speckle": 12,
    "corner_threshold": 90,
    "length_threshold": 3.5,
    "max_iterations": 10,
    "splice_threshold": 45,
    "path_precision": 2,
}
STYLE = """
    :root { --ink: #756c61; --paper: #f7f5f0; --apricot: #eed7b3; --terracotta: #d8a38b; }
    @media (prefers-color-scheme: dark) {
      :root { --ink: #c2b8a7; --paper: #34332f; --apricot: #756047; --terracotta: #ad8069; }
    }
  """


def svg_tag(name: str) -> str:
    return f"{{{NAMESPACE}}}{name}"


def palette_image() -> Image.Image:
    palette = Image.new("P", (1, 1))
    palette.putpalette([channel for color in COLORS for channel in color] + [255] * (768 - 12))
    return palette


def remove_exterior_paper(indexed: Image.Image) -> tuple[int, int]:
    """从每条边泛洪，只去除外部白底，保留闭合轮廓内的纸白。"""
    width, height = indexed.size
    for x in range(width):
        for y in (0, height - 1):
            if indexed.getpixel((x, y)) == 0:
                ImageDraw.floodfill(indexed, (x, y), 4)
    for y in range(height):
        for x in (0, width - 1):
            if indexed.getpixel((x, y)) == 0:
                ImageDraw.floodfill(indexed, (x, y), 4)
    histogram = indexed.histogram()
    return histogram[4], histogram[0]


def cubic_extrema(p0: float, p1: float, p2: float, p3: float) -> list[float]:
    """计算单轴三次贝塞尔的精确极值，包括端点。"""
    a = -p0 + 3 * p1 - 3 * p2 + p3
    b = 2 * (p0 - 2 * p1 + p2)
    c = p1 - p0
    roots = []
    if abs(a) < 1e-12:
        if abs(b) >= 1e-12:
            roots = [-c / b]
    elif b * b - 4 * a * c >= 0:
        discriminant = math.sqrt(b * b - 4 * a * c)
        roots = [(-b + discriminant) / (2 * a), (-b - discriminant) / (2 * a)]
    return [p0, p3] + [(1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1
                       + 3 * (1 - t) * t * t * p2 + t ** 3 * p3 for t in roots if 0 < t < 1]


def traced_path_bounds(path: ET.Element) -> tuple[float, float, float, float]:
    """读取 VTracer 的绝对 M/C/Z 曲线边界，不改变原有几何形状。"""
    number = r"[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?"
    translation = re.fullmatch(rf"translate\(\s*({number})\s*[, ]\s*({number})\s*\)", path.get("transform", ""))
    if translation is None or set(re.findall(r"[A-Za-z]", path.get("d", ""))) - {"M", "C", "Z"}:
        raise ValueError("VTracer 路径语法不符合预期，不猜测边界")
    dx, dy = map(float, translation.groups())
    xs, ys = [], []
    current = (0.0, 0.0)
    for command, coordinates in re.findall(r"([MCZ])([^MCZ]*)", path.get("d", "")):
        values = list(map(float, re.findall(number, coordinates)))
        if command == "M":
            if len(values) != 2:
                raise ValueError("VTracer 移动命令不符合预期")
            current = tuple(values)
            xs.append(current[0])
            ys.append(current[1])
        elif command == "C":
            if not values or len(values) % 6:
                raise ValueError("VTracer 三次曲线命令不符合预期")
            for index in range(0, len(values), 6):
                x1, y1, x2, y2, x3, y3 = values[index:index + 6]
                xs.extend(cubic_extrema(current[0], x1, x2, x3))
                ys.extend(cubic_extrema(current[1], y1, y2, y3))
                current = (x3, y3)
    return min(xs) + dx, min(ys) + dy, max(xs) + dx, max(ys) + dy


def convert_cell(
    sheet: Image.Image, source_sha256: str, source_relative: str,
    index: int, state: str, title: str, tracer_version: str,
) -> tuple[str, dict]:
    column, row = index % 3, index // 3
    bounds = (
        sheet.width * column // 3, sheet.height * row // 2,
        sheet.width * (column + 1) // 3, sheet.height * (row + 1) // 2,
    )
    cell = sheet.crop(bounds)
    palette = palette_image()
    indexed = cell.quantize(palette=palette, dither=Image.Dither.NONE)
    local_bounds = indexed.point(lambda value: 0 if value == 0 else 255).getbbox()
    if local_bounds is None:
        raise ValueError(f"{state}：等分格子内没有可描摹内容")
    cropped = cell.crop(local_bounds)
    ratio = CONTENT_SIZE * TRACE_SCALE / max(cropped.size)
    content_size = tuple(max(1, round(length * ratio)) for length in cropped.size)
    cropped = cropped.resize(content_size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (RASTER_SIZE, RASTER_SIZE), "white")
    offset = ((RASTER_SIZE - cropped.width) // 2, (RASTER_SIZE - cropped.height) // 2)
    canvas.paste(cropped, offset)
    indexed = canvas.quantize(palette=palette, dither=Image.Dither.NONE)
    exterior_pixels, interior_pixels = remove_exterior_paper(indexed)
    if not exterior_pixels or not interior_pixels:
        raise ValueError(f"{state}：必须有透明外底和保留的内部纸白")
    raster_bounds = indexed.point(lambda value: 0 if value == 4 else 255).getbbox()
    content_bounds = tuple(value / TRACE_SCALE for value in raster_bounds)
    source_bounds = [
        bounds[0] + local_bounds[0], bounds[1] + local_bounds[1],
        bounds[0] + local_bounds[2], bounds[1] + local_bounds[3],
    ]
    metadata = {
        "pipeline": "generated reference → equal 3×2 grid → palette separation → edge-connected paper removal → VTracer spline tracing",
        "source": source_relative,
        "sourceSha256": source_sha256,
        "sourceDimensions": list(sheet.size),
        "state": state,
        "cell": {"index": index, "column": column, "row": row, "columns": 3, "rows": 2, "bounds": list(bounds)},
        "sourceBounds": source_bounds,
        "contentBounds": list(content_bounds),
        "background": {
            "method": "edge-connected-paper-flood-fill",
            "exteriorPixels": exterior_pixels,
            "interiorPaperPixels": interior_pixels,
        },
        "tracer": f"vtracer {tracer_version}",
        "parameters": PARAMETERS,
        "preprocessing": {"medianFilter": MEDIAN_FILTER, "targetSize": SIZE, "maxContentSize": CONTENT_SIZE, "traceScale": TRACE_SCALE, "rasterSize": RASTER_SIZE},
        "palette": {tone: list(COLORS[color]) for tone, color in LAYERS},
        "reference": "design/brand/pinekin-icon-approved.png",
    }
    root = ET.Element(svg_tag("svg"), {
        "width": str(SIZE), "height": str(SIZE), "viewBox": f"0 0 {SIZE} {SIZE}",
    })
    ET.SubElement(root, svg_tag("title")).text = f"Pinekin · {title}"
    ET.SubElement(root, svg_tag("desc")).text = (
        "同一只长尖脸、圆耳、长颈、白胸与粗长尾松貂的生图场景，经分色与自动描摹保留原稿轮廓。"
        "外部白底透明，内部纸白保留；暖色只保留原稿实际色块，未使用的色层为空。全部为真实贝塞尔曲线路径，无嵌入位图。"
    )
    metadata_element = ET.SubElement(root, svg_tag("metadata"))
    ET.SubElement(root, svg_tag("style")).text = STYLE
    counts = {}
    for tone, color in LAYERS:
        mask = indexed.point(lambda value: 0 if value == color else 255, mode="L")
        mask = mask.filter(ImageFilter.MedianFilter(MEDIAN_FILTER))
        buffer = io.BytesIO()
        mask.save(buffer, format="PNG")
        traced = vtracer.convert_raw_image_to_svg(buffer.getvalue(), img_format="png", **PARAMETERS)
        traced_root = ET.fromstring(traced)
        group = ET.SubElement(root, svg_tag("g"), {
            "data-tone": tone, "fill": f"var(--{tone})", "fill-rule": "evenodd",
            "transform": f"scale({1 / TRACE_SCALE})",
        })
        for traced_path in traced_root.iter(svg_tag("path")):
            # 只复制 VTracer 几何路径，不接收任意 SVG 节点或属性。
            attributes = {key: value for key, value in traced_path.attrib.items() if key in ("d", "transform")}
            ET.SubElement(group, svg_tag("path"), attributes)
        counts[tone] = len(group)
        if counts[tone] == 0 and tone in ("paper", "ink"):
            raise ValueError(f"{state}：{tone} 层没有路径；分色计数={indexed.histogram()[:5]}；不编造替代几何图形")
    # 去噪可能丢弃曾影响位图裁切的背景杂点，按最终曲线而非杂点居中。
    path_bounds = [traced_path_bounds(path) for path in root.iter(svg_tag("path"))]
    left = min(bounds[0] for bounds in path_bounds)
    top = min(bounds[1] for bounds in path_bounds)
    right = max(bounds[2] for bounds in path_bounds)
    bottom = max(bounds[3] for bounds in path_bounds)
    scale = CONTENT_SIZE / max(right - left, bottom - top)
    tx = SIZE / 2 - (left + right) * scale / 2
    ty = SIZE / 2 - (top + bottom) * scale / 2
    transform = f"translate({tx:.8f} {ty:.8f}) scale({scale:.8f})"
    for group in root.findall(svg_tag("g")):
        group.set("transform", transform)
    content_bounds = [left * scale + tx, top * scale + ty, right * scale + tx, bottom * scale + ty]
    metadata["contentBounds"] = content_bounds
    metadata["vectorNormalization"] = {"transform": transform, "tracedBounds": [left, top, right, bottom]}
    metadata_element.text = json.dumps(metadata, ensure_ascii=False, separators=(",", ":"))
    ET.indent(root, space="  ")
    text = ET.tostring(root, encoding="unicode") + "\n"
    statistics = {
        "state": state, "bytes": len(text.encode("utf-8")), "paths": counts,
        "cellBounds": list(bounds), "sourceBounds": source_bounds, "contentBounds": list(content_bounds),
        "exteriorPixels": exterior_pixels, "interiorPaperPixels": interior_pixels,
    }
    return text, statistics


def main() -> None:
    repository = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", type=Path, default=repository / "design/illustrations/empty-states/source/pinekin-empty-states.png")
    parser.add_argument("--output-dir", type=Path, default=repository / "src/renderer/src/assets/empty-states")
    args = parser.parse_args()
    source = args.source.resolve()
    try:
        source_relative = source.relative_to(repository).as_posix()
    except ValueError:
        parser.error("--source 必须在当前仓库内，使元数据中的来源路径可移植")
    tracer_version = importlib.metadata.version("vtracer")
    if tracer_version != "0.6.15":
        parser.error(f"要求已有 VTracer 0.6.15，实际为 {tracer_version}；未安装任何依赖")
    source_bytes = source.read_bytes()
    source_sha256 = hashlib.sha256(source_bytes).hexdigest()
    with Image.open(io.BytesIO(source_bytes)) as original:
        if original.width < 6 or original.height < 4:
            parser.error("原稿尺寸过小，无法等分为 3×2 素材表")
        sheet = original.convert("RGB")
    ET.register_namespace("", NAMESPACE)
    # 全部转换成功后才写入，避免转换阶段失败而留下一半新素材。
    results = [convert_cell(sheet, source_sha256, source_relative, index, state, title, tracer_version)
               for index, (state, title) in enumerate(STATES)]
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for (state, _title), (text, statistics) in zip(STATES, results):
        destination = args.output_dir / f"{state}.svg"
        destination.write_text(text, encoding="utf-8")
        statistics["output"] = str(destination.resolve())
        print(json.dumps(statistics, ensure_ascii=False))
        if statistics["bytes"] >= 100 * 1024:
            print(f"警告：{state} 超过 100 KiB；请复核，不自动降低美术品质。", file=sys.stderr)


if __name__ == "__main__":
    main()
