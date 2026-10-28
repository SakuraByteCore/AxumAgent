"""真实资源回归：关节帧不是整图变换；需要构建依赖 Pillow。"""
import importlib.util
import json
import unittest
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageOps

BUILD_SPEC = importlib.util.spec_from_file_location("pet_sprites", Path(__file__).resolve().parents[1] / "plugin/pi-agent/build-pet-sprites.py")
BUILD = importlib.util.module_from_spec(BUILD_SPEC)
BUILD_SPEC.loader.exec_module(BUILD)

ROOT = Path(__file__).resolve().parents[1] / "plugin/pi-agent/assets"
SPEC = json.loads((ROOT / "desktop-pet-atlas.json").read_text())
ATLAS = Image.open(ROOT / "desktop-pet-atlas.png").convert("RGBA")
SIZE = SPEC["frameSize"]


def frame(state, index):
    row = SPEC["animations"][state]["row"]
    return ATLAS.crop((index*SIZE, row*SIZE, (index+1)*SIZE, (row+1)*SIZE))


class CharacterFrames(unittest.TestCase):
    def test_hair_shoulder_join_has_no_enclosed_cutout(self):
        for state, spec in SPEC["animations"].items():
            for index in range(spec["frames"]):
                mask = frame(state, index).getchannel("A").point(lambda p: 255 if p >= 128 else 0)
                ImageDraw.floodfill(mask, (0, 0), 128)
                holes = mask.point(lambda p: 255 if p == 0 else 0).crop((73, 80, 103, 109))
                self.assertIsNone(holes.getbbox(), (state, index))

    def test_neck_has_solid_continuous_join_in_every_frame(self):
        for state, spec in SPEC["animations"].items():
            for index in range(spec["frames"]):
                alpha = frame(state, index).getchannel("A")
                reachable = set(range(90, 103))
                for y in range(96, 109):
                    reachable = {x for x in range(85, 109) if alpha.getpixel((x, y)) >= 250
                                 and any(abs(x-previous) <= 1 for previous in reachable)}
                    self.assertTrue(reachable, (state, index, y))

    def test_all_delivered_frames_match_generator_without_clipping(self):
        head = BUILD.reference_head()
        for state, spec in SPEC["animations"].items():
            for index in range(spec["frames"]):
                actual, expected = frame(state, index), BUILD.render_frame(head, state, index)
                box = actual.getbbox()
                self.assertTrue(box[0] > 0 and box[1] > 0 and box[2] < SIZE and box[3] < SIZE)
                for background in ("white", "#202632", "#3a8556"):
                    a = Image.new("RGBA", actual.size, background)
                    b = a.copy()
                    a.alpha_composite(actual)
                    b.alpha_composite(expected)
                    self.assertEqual(a.tobytes(), b.tobytes(), (state, index, background))

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

    def test_original_face_preserved_without_blink_overlay(self):
        head = BUILD.reference_head()
        expected = Image.new("RGBA", (SIZE*BUILD.SCALE, SIZE*BUILD.SCALE))
        expected.alpha_composite(head, (46*BUILD.SCALE, 8*BUILD.SCALE))
        expected = expected.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
        face_box = (80, 74, 111, 94)
        self.assertEqual(frame("idle", 0).crop(face_box).tobytes(), expected.crop(face_box).tobytes())
        self.assertEqual(frame("waiting", 0).tobytes(), frame("waiting", 10).tobytes())

    def test_connected_matte_keeps_enclosed_highlights_and_softens_edge(self):
        sample = Image.new("RGB", (11, 11), (240, 240, 240))
        sample.paste((80, 40, 20), (3, 3, 8, 8))
        sample.putpixel((5, 5), (255, 255, 255))
        sample.putpixel((2, 5), (168, 148, 138))
        cut = BUILD.remove_white_matte(sample)
        self.assertEqual(cut.getpixel((10, 10))[3], 0)
        self.assertEqual(cut.getpixel((5, 5)), (255, 255, 255, 255))
        self.assertAlmostEqual(cut.getpixel((2, 5))[3], 128, delta=1)
        self.assertLess(max(abs(a-b) for a, b in zip(cut.getpixel((2, 5))[:3], (80, 40, 20))), 2)
        sample.paste((80, 40, 20), (5, 0, 6, 11))
        split = BUILD.remove_white_matte(sample)
        self.assertEqual(split.getpixel((0, 0))[3], 0)
        self.assertEqual(split.getpixel((10, 10))[3], 0)

    def test_head_retains_chin_and_removes_collar_without_stretch(self):
        head = BUILD.reference_head()
        source = Image.open(ROOT / "desktop-pet.png").convert("RGBA").crop(BUILD.HEAD_BOX)
        fitted = ImageOps.contain(source, head.size, Image.Resampling.LANCZOS)
        offset_y = (head.height-fitted.height)//2
        scale = fitted.width/source.width
        for point in ((400, 400), (400, 470), (400, 500), (400, 130)):
            xy = (round((point[0]-BUILD.HEAD_BOX[0])*scale), round((point[1]-BUILD.HEAD_BOX[1])*scale))
            self.assertEqual(head.getpixel((xy[0], xy[1]+offset_y)), fitted.getpixel(xy))
        self.assertEqual(head.getpixel((150, 178))[3], 0)


if __name__ == "__main__":
    unittest.main()
