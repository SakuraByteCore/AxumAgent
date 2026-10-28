"""分层资源的全帧几何验证；不替代原生输入和人工目视。"""
import json
import math
from pathlib import Path
import unittest
from PIL import Image, ImageChops, ImageStat

ASSETS = Path(__file__).resolve().parents[1] / "plugin/pi-agent/assets"


class MotionTest(unittest.TestCase):
    def test_layers_extremes_and_neutral_baseline(self):
        spec = json.loads((ASSETS / "desktop-pet-atlas.json").read_text())
        motion = json.loads((ASSETS / "desktop-pet-motion/motion.json").read_text())
        atlas = Image.open(ASSETS / "desktop-pet-atlas.png").convert("RGBA")
        body = Image.open(ASSETS / "desktop-pet-motion/body.png").convert("RGBA")
        head = Image.open(ASSETS / "desktop-pet-motion/head.png").convert("RGBA")
        self.assertEqual(atlas.size, body.size)
        self.assertEqual(atlas.size, head.size)
        size = spec["frameSize"]; px, py = motion["pivot"]
        peak = 0; mean = 0; checked = 0
        for state, animation in spec["animations"].items():
            for index in range(animation["frames"]):
                x, y = index*size, animation["row"]*size
                box = (x,y,x+size,y+size)
                bottom, top, old = body.crop(box), head.crop(box), atlas.crop(box)
                for gx in (-1.5, 0, 1.5):
                    for gy in (-.8, 0, .8):
                        angle = math.radians(gx*motion["rotationPerX"])
                        c, s = math.cos(angle), math.sin(angle)
                        tx, ty = gx*motion["translationScale"], gy*motion["translationScale"]
                        inverse = (c,s,px-c*(px+tx)-s*(py+ty),-s,c,py+s*(px+tx)-c*(py+ty))
                        moved = top.transform(top.size, Image.Transform.AFFINE, inverse, Image.Resampling.BICUBIC)
                        merged = Image.alpha_composite(bottom, moved)
                        alpha = merged.getchannel("A")
                        bounds = alpha.getbbox()
                        self.assertTrue(bounds[0] > 0 and bounds[1] > 0 and bounds[2] < size and bounds[3] < size)
                        reachable = set(range(90,103))
                        for row in range(96,109):
                            reachable = {col for col in range(85,109) if alpha.getpixel((col,row)) >= 250
                                         and any(abs(col-previous) <= 1 for previous in reachable)}
                            self.assertTrue(reachable, (state,index,gx,gy,row))
                        self.assertEqual(merged.crop((0,132,size,size)).tobytes(), bottom.crop((0,132,size,size)).tobytes())
                        checked += 1
                        if gx == gy == 0:
                            for color in ("white", "#202632", "#3a8556"):
                                bg = Image.new("RGBA", old.size, color)
                                diff = ImageChops.difference(Image.alpha_composite(bg,merged),Image.alpha_composite(bg,old))
                                peak = max(peak, *(high for low, high in diff.getextrema()))
                                mean = max(mean, *ImageStat.Stat(diff).mean[:3])
        self.assertEqual(peak, motion["neutralMaxChannelError"])
        print(json.dumps({"transforms":checked,"neutralMaxChannelError":peak,"neutralMaxMeanChannelError":mean}))


if __name__ == "__main__":
    unittest.main()
