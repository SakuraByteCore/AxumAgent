#!/usr/bin/env python3
"""离线生成参考头像纸偶动画；构建需 Pillow，桌面运行不依赖 Pillow。"""
import json
import math
from collections import deque
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent / "assets"
SIZE, SCALE, FRAMES = 192, 2, 12
STATES = ("idle", "walk", "wave", "working", "waiting", "failed")
INK = "#4f2425"
CLOTH = "#e6dcd3"
SHADE = "#bfb7b4"
SKIN = "#feefe2"
BOOT = "#493b43"


def reference_head():
    source = Image.open(ROOT / "desktop-pet.png").convert("RGBA")
    pixels = source.load()
    seen, queue = set(), deque([(0, 0)])
    while queue:
        x, y = queue.popleft()
        if (x, y) in seen or not (0 <= x < source.width and 0 <= y < source.height):
            continue
        seen.add((x, y))
        r, g, b, a = pixels[x, y]
        if min(r, g, b) < 245:
            continue
        pixels[x, y] = (r, g, b, 0)
        queue.extend(((x-1, y), (x+1, y), (x, y-1), (x, y+1)))
    # 参考头部采样区；衣服和四肢为重新绘制的纸偶，不切割原图冒充完整骨架。
    return source.crop((178, 65, 632, 493)).resize((100*SCALE, 100*SCALE), Image.Resampling.LANCZOS)


def line(draw, points, color, width):
    draw.line([(round(x*SCALE), round(y*SCALE)) for x, y in points], fill=color, width=round(width*SCALE), joint="curve")


def ellipse(draw, box, color, outline=None):
    draw.ellipse(tuple(round(n*SCALE) for n in box), fill=color, outline=outline, width=SCALE)


def polygon(draw, points, color):
    draw.polygon([(round(x*SCALE), round(y*SCALE)) for x, y in points], fill=color)
    line(draw, points + [points[0]], INK, 1.3)


def limb(draw, points, width, color):
    line(draw, points, INK, width+2)
    line(draw, points, color, width)
    for x, y in points[1:-1]:
        ellipse(draw, (x-width/2, y-width/2, x+width/2, y+width/2), color)


def arm(draw, pose):
    shoulder, elbow, wrist, fingers = pose
    limb(draw, [shoulder, elbow], 12, CLOTH)
    limb(draw, [elbow, wrist], 8, SKIN)
    x, y = wrist
    ellipse(draw, (x-5, y-5, x+5, y+5), SKIN, INK)
    if fingers:
        for dx, length in [(-4, 6), (-1, 9), (2, 8), (5, 5)]:
            line(draw, [(x+dx, y-1), (x+dx, y-length)], SKIN, 2.2)


def legs(draw, state, phase):
    stride = math.sin(phase)*8 if state == "walk" else 0
    for side in [-1, 1]:
        hip = (96+side*12, 142)
        knee = (96+side*12+side*stride, 160)
        foot = (96+side*15+side*stride, 180-abs(stride)*0.4)
        limb(draw, [hip, knee, foot], 10, SHADE)
        ellipse(draw, (foot[0]-7, foot[1]-3, foot[0]+9, foot[1]+4), BOOT, INK)


def face(head, state, frame):
    result = head.copy()
    draw = ImageDraw.Draw(result)
    # 局部重绘五官，避免把整张头像压扁来模拟眨眼。
    ellipse(draw, (29, 64, 72, 96), SKIN)
    closed = frame in (10, 11) and state in ("idle", "waiting")
    for x in (40, 61):
        if state == "failed":
            line(draw, [(x-4, 77), (x+3, 80)], INK, 2)
            line(draw, [(x-4, 73), (x+3, 70)], INK, 1.2)
        elif closed:
            line(draw, [(x-4, 79), (x+4, 79)], INK, 1.8)
        else:
            ellipse(draw, (x-2, 75, x+2, 82), INK)
            ellipse(draw, (x-1, 75, x+1, 77), "#fff8ef")
        ellipse(draw, (x-5, 84, x+4, 86), "#e7b2aa")
    if state == "failed":
        line(draw, [(46, 91), (50, 88), (55, 91)], INK, 1.3)
    elif state == "waiting":
        ellipse(draw, (49, 88, 53, 92), INK)
    else:
        line(draw, [(46, 88), (50, 91), (55, 88)], INK, 1.3)
    return result


def arm_poses(state, phase):
    swing = math.sin(phase)
    left = ((72, 110), (63, 127), (64, 143), False)
    right = ((120, 110), (131, 127), (130, 143), False)
    if state == "wave":
        right = ((120, 110), (140, 99), (145+swing*6, 72), True)
    elif state == "walk":
        left = ((72, 110), (60, 126), (61+swing*10, 143-swing*4), False)
        right = ((120, 110), (132, 126), (131-swing*10, 143+swing*4), False)
    elif state == "working":
        left = ((72, 110), (66, 128), (83, 138+swing*3), False)
        right = ((120, 110), (126, 128), (109, 138-swing*3), False)
    elif state == "waiting":
        right = ((120, 110), (132, 115), (119, 97), False)
    elif state == "failed":
        left = ((72, 114), (65, 132), (65, 149), False)
        right = ((120, 114), (127, 132), (127, 149), False)
    return left, right


def render_frame(head, state, frame):
    phase = math.tau*frame/FRAMES
    image = Image.new("RGBA", (SIZE*SCALE, SIZE*SCALE))
    draw = ImageDraw.Draw(image)
    legs(draw, state, phase)
    breath = math.sin(phase) if state == "idle" else 0
    polygon(draw, [(73, 103), (119, 103), (127, 148), (65, 148)], CLOTH)
    line(draw, [(96, 109), (96, 143)], SHADE, 2)
    polygon(draw, [(86, 106), (96, 115+breath), (106, 106)], "#eefefe")
    left, right = arm_poses(state, phase)
    arm(draw, left)
    if state == "working":
        polygon(draw, [(71, 133), (121, 133), (128, 149), (64, 149)], "#688083")
        for x in range(74, 120, 8):
            line(draw, [(x, 137), (x+2, 143)], "#eefefe", 2)
    arm(draw, right)
    avatar = face(head, state, frame)
    tilt = -8 if state == "failed" else (7 if state == "waiting" else 0)
    avatar = avatar.rotate(tilt, Image.Resampling.BICUBIC, expand=False)
    image.alpha_composite(avatar, (46*SCALE, round((8+(5 if state == "failed" else breath))*SCALE)))
    return image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)


def main():
    head = reference_head()
    atlas = Image.new("RGBA", (SIZE*FRAMES, SIZE*len(STATES)))
    animations = {}
    previews = []
    for row, state in enumerate(STATES):
        frames = [render_frame(head, state, frame) for frame in range(FRAMES)]
        for column, frame in enumerate(frames):
            atlas.alpha_composite(frame, (column*SIZE, row*SIZE))
        animations[state] = {"row": row, "frames": FRAMES, "fps": 6 if state in ("idle", "waiting", "failed") else 12}
        previews.extend(frame for frame in frames for _ in range(2 if animations[state]["fps"] == 6 else 1))
    atlas.save(ROOT / "desktop-pet-atlas.png", optimize=True)
    manifest = {"frameSize": SIZE, "animations": animations, "style": "reference-head-paper-puppet"}
    (ROOT / "desktop-pet-atlas.json").write_text(json.dumps(manifest, indent=2)+"\n")
    previews[0].save(ROOT / "desktop-pet-preview.webp", save_all=True, append_images=previews[1:], duration=83, loop=0, lossless=True)
    print(f"Generated {len(STATES)*FRAMES} character frames; atlas {atlas.size}")


if __name__ == "__main__":
    main()
