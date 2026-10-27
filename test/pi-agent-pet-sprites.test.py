"""真实资源回归：关节帧不是整图变换；需要构建依赖 Pillow。"""
import json
import unittest
from pathlib import Path
from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[1] / "plugin/pi-agent/assets"
SPEC = json.loads((ROOT / "desktop-pet-atlas.json").read_text())
ATLAS = Image.open(ROOT / "desktop-pet-atlas.png").convert("RGBA")
SIZE = SPEC["frameSize"]


def frame(state, index):
    row = SPEC["animations"][state]["row"]
    return ATLAS.crop((index*SIZE, row*SIZE, (index+1)*SIZE, (row+1)*SIZE))


class CharacterFrames(unittest.TestCase):
    def test_atlas_contract(self):
        self.assertEqual(set(SPEC["animations"]), {"idle", "walk", "wave", "working", "waiting", "failed"})
        self.assertEqual(ATLAS.size, (max(s["frames"] for s in SPEC["animations"].values())*SIZE, len(SPEC["animations"])*SIZE))
        self.assertEqual(frame("idle", 0).getpixel((0, 0))[3], 0)

    def test_wave_moves_hand_not_body_or_head(self):
        a, b = frame("wave", 0), frame("wave", 3)
        self.assertEqual(a.crop((40, 0, 130, 185)).tobytes(), b.crop((40, 0, 130, 185)).tobytes())
        self.assertIsNotNone(ImageChops.difference(a, b).getbbox())

    def test_walk_and_typing_are_local_motion(self):
        for state in ("walk", "working"):
            a, b = frame(state, 0), frame(state, 3)
            self.assertEqual(a.crop((40, 0, 135, 110)).tobytes(), b.crop((40, 0, 135, 110)).tobytes())
            self.assertNotEqual(a.crop((45, 120, 145, 190)).tobytes(), b.crop((45, 120, 145, 190)).tobytes())

    def test_blink_and_sad_expression(self):
        self.assertNotEqual(frame("waiting", 0).tobytes(), frame("waiting", 10).tobytes())
        self.assertNotEqual(frame("idle", 0).crop((70, 70, 120, 110)).tobytes(), frame("failed", 0).crop((70, 70, 120, 110)).tobytes())


if __name__ == "__main__":
    unittest.main()
