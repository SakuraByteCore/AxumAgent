#!/usr/bin/env python3
"""只读复用纸偶生成器，导出身体与逐动作原头像；不执行旧 main。"""
import hashlib
import importlib.util
import json
import math
from pathlib import Path
from PIL import Image, ImageChops

HERE = Path(__file__).resolve().parent
OUTPUT = HERE / "assets/desktop-pet-motion"
PIVOT = (96, 96)
ROTATION_PER_X = 1.3
TRANSLATION_SCALE = 1.2


def head_frame(generator, head, state_frame):
    state, frame = state_frame
    tilt = -8 if state == "failed" else (7 if state == "waiting" else 0)
    breath = math.sin(math.tau*frame/generator.FRAMES) if state == "idle" else 0
    head_y = generator.HEAD_ORIGIN[1] + (5 if state == "failed" else breath)
    avatar = head.rotate(tilt, Image.Resampling.BICUBIC, expand=True)
    position = (generator.HEAD_ORIGIN[0]*generator.SCALE+(head.width-avatar.width)//2,
                round(head_y*generator.SCALE)+(head.height-avatar.height)//2)
    layer = Image.new("RGBA", (generator.SIZE*generator.SCALE,)*2)
    layer.alpha_composite(avatar, position)
    return layer.resize((generator.SIZE,)*2, Image.Resampling.LANCZOS)


def main():
    source = HERE / "build-pet-sprites.py"
    spec = importlib.util.spec_from_file_location("pet_sprites", source)
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    head = generator.reference_head()
    transparent = Image.new("RGBA", head.size)
    old = Image.open(generator.ROOT / "desktop-pet-atlas.png").convert("RGBA")
    body_atlas, head_atlas = (Image.new("RGBA", old.size) for _ in range(2))
    peak_error = 0
    for row, state in enumerate(generator.STATES):
        for index in range(generator.FRAMES):
            body = generator.render_frame(transparent, state, index)
            top = head_frame(generator, head, (state, index))
            position = (index*generator.SIZE, row*generator.SIZE)
            expected = old.crop((*position, position[0]+generator.SIZE, position[1]+generator.SIZE))
            baseline = Image.new("RGBA", expected.size)
            baseline.alpha_composite(generator.render_frame(head, state, index))
            assert baseline.tobytes() == expected.tobytes()
            merged = Image.alpha_composite(body, top)
            # 分层后独立降采样会改变软边，比较可见 RGB 而不是透明像素 RGB。
            for color in ("white", "#202632", "#3a8556"):
                background = Image.new("RGBA", merged.size, color)
                diff = ImageChops.difference(Image.alpha_composite(background, merged),
                                            Image.alpha_composite(background, expected))
                peak_error = max(peak_error, *(high for low, high in diff.getextrema()))
            body_atlas.paste(body, position)
            head_atlas.paste(top, position)
    OUTPUT.mkdir(exist_ok=True)
    body_atlas.save(OUTPUT / "body.png", optimize=True)
    head_atlas.save(OUTPUT / "head.png", optimize=True)
    metadata = {"frameSize": generator.SIZE, "pivot": PIVOT,
                "rotationPerX": ROTATION_PER_X, "translationScale": TRANSLATION_SCALE,
                "generatorSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "atlasSha256": hashlib.sha256((generator.ROOT / "desktop-pet-atlas.png").read_bytes()).hexdigest(),
                "neutralMaxChannelError": peak_error}
    (OUTPUT / "motion.json").write_text(json.dumps(metadata, indent=2)+"\n", encoding="utf-8")
    print(json.dumps({"size": old.size, "frames": len(generator.STATES)*generator.FRAMES,
                      "neutralMaxChannelError": peak_error, "output": str(OUTPUT)}))


if __name__ == "__main__":
    main()
