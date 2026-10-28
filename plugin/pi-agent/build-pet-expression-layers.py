#!/usr/bin/env python3
"""Derive local eye/hood motion from existing pixels; never paint over the face."""
import hashlib
import importlib.util
import json
import math
from pathlib import Path
from PIL import Image, ImageChops

HERE = Path(__file__).resolve().parent
OUTPUT = HERE / "assets/desktop-pet-expression"
# Reference-head coordinates, verified against opaque eye/glint components.
EYES = ((49, 112, 82, 144, 116, 141), (112, 110, 146, 142, 114, 139))
# The two disconnected alpha runs at y=10 are hood tips; roots stay at y=44.
EARS = ((30, 4, 73, 44), (123, 4, 165, 44))
# Side alpha components below the eyes are hair tips, outside the cheek.
HAIR = ((10, 144, 46, 198), (163, 137, 198, 184))
BLINK_AMOUNTS = (0.0, 0.55, 0.94)
SWAY_STEPS = 4
SWAY_AMOUNTS = tuple(range(-SWAY_STEPS, SWAY_STEPS+1))
EAR_SHIFT = 2.0
EDGE_WIDTH = 3.0


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def edge_weight(value, low, high):
    return min(1.0, max(0.0, min(value-low, high-value) / EDGE_WIDTH))


def sample(pixels, point):
    x, y = point
    left, top = math.floor(x), math.floor(y)
    fx, fy = x-left, y-top
    weights = ((1-fx)*(1-fy), fx*(1-fy), (1-fx)*fy, fx*fy)
    colors = (pixels[left, top], pixels[left+1, top], pixels[left, top+1], pixels[left+1, top+1])
    alpha = sum(c[3]*w for c, w in zip(colors, weights))
    rgb = [round(sum(c[k]*c[3]*w for c, w in zip(colors, weights))/alpha) if alpha else 0
           for k in range(3)]
    return (*rgb, round(alpha))


def eye_source_y(y, eye, amount):
    x0, y0, x1, y1, upper, lower = eye
    center = (upper+lower)/2
    top = upper + (center-upper)*amount
    bottom = lower - (lower-center)*amount
    if y < top:
        return y0+(y-y0)*(upper-y0)/(top-y0)
    if y <= bottom:
        return upper+(y-top)*(lower-upper)/(bottom-top)
    return lower+(y-bottom)*(y1-lower)/(y1-bottom)


def deform_eyes(head, blink):
    result = head.copy()
    source, target = head.load(), result.load()
    for eye in EYES:
        x0, y0, x1, y1 = eye[:4]
        for y in range(y0+1, y1):
            for x in range(x0+1, x1):
                amount = blink*edge_weight(x, x0, x1)
                target[x, y] = sample(source, (x, eye_source_y(y, eye, amount)))
    return result


def deform(head, expression):
    blink, sway = expression
    result = deform_eyes(head, blink) if blink else head.copy()
    source, target = head.load(), result.load()
    for x0, y0, x1, y1 in (*EARS, *HAIR):
        for y in range(y0+1, y1):
            for x in range(x0+1, x1):
                weight = edge_weight(x, x0, x1)*edge_weight(y, y0, y1)
                flex = (y1-y)/(y1-y0) if (x0, y0, x1, y1) in EARS else (y-y0)/(y1-y0)
                shift = sway*EAR_SHIFT*flex**2*weight
                target[x, y] = sample(source, (x-shift, y)) if shift else source[x, y]
    return result


def make_atlas(modules, head):
    generator, motion = modules
    atlas = Image.new("RGBA", (generator.SIZE*generator.FRAMES, generator.SIZE*len(generator.STATES)))
    for row, state in enumerate(generator.STATES):
        for frame in range(generator.FRAMES):
            atlas.paste(motion.head_frame(generator, head, (state, frame)),
                        (frame*generator.SIZE, row*generator.SIZE))
    return atlas


def verify_local(head, changed):
    diff = ImageChops.difference(head, changed)
    allowed = Image.new("L", head.size)
    from PIL import ImageDraw
    draw = ImageDraw.Draw(allowed)
    for region in (*EYES, *EARS, *HAIR):
        x0, y0, x1, y1 = region[:4]
        draw.rectangle((x0+1, y0+1, x1-1, y1-1), fill=255)
    outside = ImageChops.invert(allowed)
    assert all(ImageChops.multiply(channel, outside).getbbox() is None for channel in diff.split())
    return diff.convert("RGB").getbbox()


def compact_atlas(atlas, generator):
    cells, positions, frame_map = [], {}, {}
    for row, state in enumerate(generator.STATES):
        frame_map[state] = []
        for frame in range(generator.FRAMES):
            x, y, size = frame*generator.SIZE, row*generator.SIZE, generator.SIZE
            cell = atlas.crop((x, y, x+size, y+size))
            key = hashlib.sha256(cell.tobytes()).digest()
            if key not in positions:
                positions[key] = len(cells)
                cells.append(cell)
            frame_map[state].append(positions[key])
    result = Image.new("RGBA", (generator.SIZE*len(cells), generator.SIZE))
    for index, cell in enumerate(cells):
        result.paste(cell, (index*generator.SIZE, 0))
    return result, frame_map


def save_review(modules, head):
    generator, motion = modules
    body = Image.open(HERE / "assets/desktop-pet-motion/body.png").convert("RGBA")
    size = generator.SIZE
    canvas = Image.new("RGBA", (size*len(BLINK_AMOUNTS), size), "#333a46")
    for index, blink in enumerate(BLINK_AMOUNTS):
        top = motion.head_frame(generator, deform(head, (blink, 0)), ("idle", 0))
        frame = Image.alpha_composite(body.crop((0, 0, size, size)), top)
        canvas.alpha_composite(frame, (index*size, 0))
    canvas.save(OUTPUT / "review.png", optimize=True)


def main():
    generator = load_module("pet_sprites", "build-pet-sprites.py")
    motion = load_module("pet_motion", "build-pet-motion-layers.py")
    head = generator.reference_head()
    neutral_path = HERE / "assets/desktop-pet-motion/head.png"
    neutral = Image.open(neutral_path).convert("RGBA")
    assert make_atlas((generator, motion), head).tobytes() == neutral.tobytes()
    assert deform(head, (0, 0)).tobytes() == head.tobytes()
    OUTPUT.mkdir(exist_ok=True)
    variants = {}
    for blink, amount in enumerate(BLINK_AMOUNTS):
        for sway in SWAY_AMOUNTS:
            key = f"{blink}:{sway}"
            if key == "0:0":
                continue
            changed = deform(head, (amount, sway/SWAY_STEPS))
            bounds = verify_local(head, changed)
            atlas, frame_map = compact_atlas(make_atlas((generator, motion), changed), generator)
            filename = f"head-{blink}-{sway}.png"
            atlas.save(OUTPUT / filename, optimize=True)
            variants[key] = {"file": filename, "sha256": hashlib.sha256((OUTPUT / filename).read_bytes()).hexdigest(),
                             "localDifference": bounds, "frames": frame_map}
    spec = {"frameSize": generator.SIZE, "neutral": "../desktop-pet-motion/head.png",
            "neutralSha256": hashlib.sha256(neutral_path.read_bytes()).hexdigest(),
            "variants": variants, "eyeRegions": EYES, "hoodRegions": EARS, "hairRegions": HAIR,
            "blinkAmounts": BLINK_AMOUNTS, "blinkSeconds": 0.24, "blinkInterval": [3.2, 6.8],
            "swayPeriod": 5.6, "swaySteps": SWAY_STEPS, "blinkHold": [0.25, 0.75],
            "visualApproval": "pending", "method": "local inverse texture mapping, fixed boundary, no painted face"}
    (OUTPUT / "expression.json").write_text(json.dumps(spec, indent=2)+"\n", encoding="utf-8")
    save_review((generator, motion), head)
    print(json.dumps({"output": str(OUTPUT), "variants": len(variants), "neutralExact": True,
                      "localBoundaryVerified": True, "framesPerVariant": len(generator.STATES)*generator.FRAMES}))


if __name__ == "__main__":
    main()
