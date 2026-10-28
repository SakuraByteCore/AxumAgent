"""Local texture invariants; visual approval is deliberately not asserted."""
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("expression", ROOT / "plugin/pi-agent/build-pet-expression-layers.py")
expression = importlib.util.module_from_spec(spec)
spec.loader.exec_module(expression)


class ExpressionTest(unittest.TestCase):
    def test_local_pixels_and_all_consumed_frames(self):
        generator = expression.load_module("sprites", "build-pet-sprites.py")
        motion = expression.load_module("motion", "build-pet-motion-layers.py")
        head = generator.reference_head()
        spec = json.loads((expression.OUTPUT / "expression.json").read_text())
        neutral = ROOT / "plugin/pi-agent/assets/desktop-pet-motion/head.png"
        self.assertEqual(hashlib.sha256(neutral.read_bytes()).hexdigest(), spec["neutralSha256"])
        self.assertEqual(expression.deform(head, (0, 0)).tobytes(), head.tobytes())
        mask = Image.new("L", head.size)
        for region in (*expression.EYES, *expression.EARS, *expression.HAIR):
            x0, y0, x1, y1 = region[:4]
            ImageDraw.Draw(mask).rectangle((x0+1, y0+1, x1-1, y1-1), fill=255)
        outside = ImageChops.invert(mask)
        self.assertLessEqual(expression.EAR_SHIFT/spec["swaySteps"], .5)
        checked = 0
        for key, variant in spec["variants"].items():
            blink, sway = map(int, key.split(":"))
            warped = expression.deform(head, (spec["blinkAmounts"][blink], sway/spec["swaySteps"]))
            difference = ImageChops.difference(head, warped)
            self.assertIsNotNone(difference.convert("RGB").getbbox())
            for channel in difference.split():
                self.assertIsNone(ImageChops.multiply(channel, outside).getbbox())
            if sway == 0:
                self.assertEqual(head.getchannel("A").tobytes(), warped.getchannel("A").tobytes())
            path = expression.OUTPUT / variant["file"]
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), variant["sha256"])
            atlas = Image.open(path).convert("RGBA")
            for state in generator.STATES:
                self.assertEqual(len(variant["frames"][state]), generator.FRAMES)
                for frame, cell in enumerate(variant["frames"][state]):
                    size = generator.SIZE
                    actual = atlas.crop((cell*size, 0, (cell+1)*size, size))
                    expected = motion.head_frame(generator, warped, (state, frame))
                    self.assertEqual(actual.tobytes(), expected.tobytes())
                    checked += 1
        print(json.dumps({"variantFrameMappings": checked, "localBoundary": True,
                          "neutralExact": True, "visualApproval": "pending"}))


if __name__ == "__main__":
    unittest.main()
