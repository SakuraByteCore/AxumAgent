#!/usr/bin/env python3
"""离线生成参考头像纸偶动画；构建需 Pillow，桌面运行不依赖 Pillow。"""
import json
import math
from collections import deque
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parent / "assets"
SIZE, SCALE, FRAMES = 192, 2, 12
STATES = ("idle", "walk", "wave", "working", "waiting", "failed")
INK = "#4f2425"
CLOTH = "#e6dcd3"
SHADE = "#bfb7b4"
SKIN = "#feefe2"
BOOT = "#493b43"
HEAD_BOX = (160, 55, 654, 540)
HEAD_SIZE = 100*SCALE
BACKGROUND_MIN, BACKGROUND_CHROMA = 232, 24
MATTE_RADIUS = 2
WHITE = 255
HEAD_ORIGIN = (46, 8)
NECK_ROOT = (96, 108)
NECK_HALF_WIDTH = 5
JAW_ANCHOR = (48, 88)
# 原图坐标：沿发梢与下颌分离衣领，不让矩形裁剪横切下巴或夹带肩部。
HEAD_OUTLINE = (
    (160, 55), (654, 55), (654, 486), (645, 494), (635, 488),
    (620, 477), (605, 464), (590, 452), (574, 443), (550, 439),
    (509, 434), (500, 447), (488, 461), (473, 475), (454, 487),
    (432, 498), (414, 506), (402, 509), (388, 505), (369, 497),
    (351, 503), (331, 510), (315, 512), (301, 508),
    (298, 520), (287, 515), (277, 510), (273, 520), (260, 514),
    (252, 508), (240, 518), (224, 534), (207, 539), (160, 539),
)


def background_mask(source):
    candidate = Image.new("L", source.size)
    candidate.putdata([int(min(rgb) >= BACKGROUND_MIN and max(rgb)-min(rgb) <= BACKGROUND_CHROMA)
                       for rgb in source.getdata()])
    pixels, queue = candidate.load(), deque()
    width, height = source.size
    queue.extend((x, y) for x in range(width) for y in (0, height-1))
    queue.extend((x, y) for y in range(height) for x in (0, width-1))
    while queue:
        x, y = queue.popleft()
        if pixels[x, y] != 1:
            continue
        pixels[x, y] = WHITE
        queue.extend((nx, ny) for nx, ny in ((x-1, y), (x+1, y), (x, y-1), (x, y+1))
                     if 0 <= nx < width and 0 <= ny < height)
    return candidate.point(lambda value: WHITE if value == WHITE else 0)


def remove_white_matte(source):
    background = background_mask(source)
    edge = background.filter(ImageFilter.MaxFilter(MATTE_RADIUS*2+1))
    local_dark = source.filter(ImageFilter.MinFilter(MATTE_RADIUS*2+1))
    result = Image.new("RGBA", source.size)
    pixels = []
    for rgb, bg, near_bg, dark in zip(source.getdata(), background.getdata(), edge.getdata(), local_dark.getdata()):
        alpha = 1.0
        if bg:
            alpha = 0.0
        elif near_bg and min(dark) < WHITE:
            alpha = min(1.0, (WHITE-min(rgb))/(WHITE-min(dark)))
        color = tuple(round(WHITE+(channel-WHITE)/alpha) for channel in rgb) if alpha else (0, 0, 0)
        pixels.append((*color, round(alpha*WHITE)))
    result.putdata(pixels)
    return result


def rounded_contour(points):
    # 二次角点切分，保持轮廓在原控制多边形内部，不产生曲线过冲。
    for _ in range(2):
        pairs = zip(points, points[1:]+points[:1])
        points = [((1-t)*a[0]+t*b[0], (1-t)*a[1]+t*b[1])
                  for a, b in pairs for t in (0.25, 0.75)]
    return points



def reference_head():
    source = Image.open(ROOT / "desktop-pet.png").convert("RGB")
    head = remove_white_matte(source.crop(HEAD_BOX))
    outline = Image.new("L", head.size)
    ImageDraw.Draw(outline).polygon([(x-HEAD_BOX[0], y-HEAD_BOX[1]) for x, y in HEAD_OUTLINE], fill=WHITE)
    outline = outline.filter(ImageFilter.GaussianBlur(0.65))
    head.putalpha(ImageChops.multiply(head.getchannel("A"), outline))
    fitted = ImageOps.contain(head, (HEAD_SIZE, HEAD_SIZE), Image.Resampling.LANCZOS)
    result = Image.new("RGBA", (HEAD_SIZE, HEAD_SIZE))
    result.alpha_composite(fitted, ((HEAD_SIZE-fitted.width)//2, (HEAD_SIZE-fitted.height)//2))
    return result

def line(draw, points, color, width):
    draw.line([(round(x*SCALE), round(y*SCALE)) for x, y in points], fill=color, width=round(width*SCALE), joint="curve")


def ellipse(draw, box, color, outline=None):
    draw.ellipse(tuple(round(n*SCALE) for n in box), fill=color, outline=outline, width=SCALE)


def polygon(draw, points, color):
    draw.polygon([(round(x*SCALE), round(y*SCALE)) for x, y in points], fill=color)
    line(draw, points + [points[0]], INK, 1.3)


def limb(draw, points, width, color):
    for stroke_width, stroke_color in ((width+2, INK), (width, color)):
        line(draw, points, stroke_color, stroke_width)
        radius = stroke_width/2
        for x, y in points:
            ellipse(draw, (x-radius, y-radius, x+radius, y+radius), stroke_color)


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


def draw_neck(draw, tilt, head_y):
    # 与头像绕中心旋转的变换一致；上端藏在下颌后，下端藏在衣领后。
    angle = math.radians(tilt)
    center = HEAD_SIZE/(2*SCALE)
    dx, dy = JAW_ANCHOR[0]-center, JAW_ANCHOR[1]-center
    jaw_x = HEAD_ORIGIN[0]+center+dx*math.cos(angle)+dy*math.sin(angle)
    jaw_y = head_y+center-dx*math.sin(angle)+dy*math.cos(angle)
    limb(draw, [(jaw_x, jaw_y), NECK_ROOT], NECK_HALF_WIDTH*2, SKIN)



def render_frame(head, state, frame):
    phase = math.tau*frame/FRAMES
    image = Image.new("RGBA", (SIZE*SCALE, SIZE*SCALE))
    draw = ImageDraw.Draw(image)
    legs(draw, state, phase)
    breath = math.sin(phase) if state == "idle" else 0
    tilt = -8 if state == "failed" else (7 if state == "waiting" else 0)
    head_y = HEAD_ORIGIN[1]+(5 if state == "failed" else breath)
    draw_neck(draw, tilt, head_y)
    polygon(draw, rounded_contour([(70, 109), (74, 99), (87, 96), (96, 98),
                                   (105, 96), (117, 101), (122, 109),
                                   (127, 148), (65, 148)]), CLOTH)
    line(draw, [(96, 109), (96, 143)], SHADE, 2)
    polygon(draw, [(86, 106), (96, 115+breath), (106, 106)], "#eefefe")
    left, right = arm_poses(state, phase)
    arm(draw, left)
    if state == "working":
        polygon(draw, [(71, 133), (121, 133), (128, 149), (64, 149)], "#688083")
        for x in range(74, 120, 8):
            line(draw, [(x, 137), (x+2, 143)], "#eefefe", 2)
    arm(draw, right)
    avatar = head.rotate(tilt, Image.Resampling.BICUBIC, expand=True)
    position = (HEAD_ORIGIN[0]*SCALE+(head.width-avatar.width)//2,
                round(head_y*SCALE)+(head.height-avatar.height)//2)
    image.alpha_composite(avatar, position)
    return image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)


def save_cutout_review(head):
    backgrounds = ("#ffffff", "#202632", "#3a8556")
    label_height = 24
    review = Image.new("RGB", (SIZE*len(STATES), (SIZE+label_height)*len(backgrounds)))
    draw = ImageDraw.Draw(review)
    for row, background in enumerate(backgrounds):
        for column, state in enumerate(STATES):
            x, y = column*SIZE, row*(SIZE+label_height)
            panel = Image.new("RGBA", (SIZE, SIZE+label_height), background)
            panel.alpha_composite(render_frame(head, state, 0), (0, label_height))
            review.paste(panel.convert("RGB"), (x, y))
            draw.text((x+8, y+6), state, fill=INK if row == 0 else "white")
    review.save(ROOT / "desktop-pet-cutout-review.png", optimize=True)



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
    (ROOT / "desktop-pet-atlas.json").write_text(json.dumps(manifest, indent=2)+"\n", encoding="utf-8", newline="\n")
    previews[0].save(ROOT / "desktop-pet-preview.webp", save_all=True, append_images=previews[1:], duration=83, loop=0, lossless=True)
    print(f"Generated {len(STATES)*FRAMES} character frames; atlas {atlas.size}")
    save_cutout_review(head)


if __name__ == "__main__":
    main()
