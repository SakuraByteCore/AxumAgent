"""Real Qt widget/dispatcher regression; offscreen is not native desktop UAT."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QEvent, QPoint, Qt, QTimer
from PySide6.QtGui import QContextMenuEvent
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("desktop_pet", ROOT / "plugin/pi-agent/desktop-pet.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
app = QApplication.instance() or QApplication([])


class InteractionTest(unittest.TestCase):
    def test_gestures_state_and_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            state.write_text('{"state":"idle"}')
            pet = module.DesktopPet(state, ROOT / "plugin/pi-agent/assets/desktop-pet.png", os.getpid())
            pet.show()
            expressions = set()
            observer = QTimer()
            observer.timeout.connect(lambda: expressions.add(pet.expression_key))
            observer.start(15)
            try:
                QTest.qWait(80)
                for point in (QPoint(145, 55), QPoint(60, 120)):
                    QTest.mouseMove(pet, point); QTest.qWait(240)
                    self.assertGreater(pet.gaze_x*pet.target_x, 0)
                    self.assertGreater(pet.gaze_y*pet.target_y, 0)
                    rendered = pet.composite.toImage()
                    gaze = (pet.gaze_x, pet.gaze_y)
                    pet.gaze_x = pet.gaze_y = 0; pet.compose_frame()
                    neutral = pet.composite.toImage()
                    self.assertNotEqual(rendered.copy(0, 0, 160, 90), neutral.copy(0, 0, 160, 90))
                    self.assertEqual(rendered.copy(0, 110, 160, 50), neutral.copy(0, 110, 160, 50))
                    pet.gaze_x, pet.gaze_y = gaze; pet.compose_frame()
                    for y in range(module.IMAGE_SIZE):
                        for x in range(module.IMAGE_SIZE):
                            local = QPoint(20+x, 14+y)
                            self.assertEqual(pet.hit_pet(local), pet.composite.toImage().pixelColor(x,y).alpha() > 24)
                    pet.repaint()
                    self.assertEqual(pet.mask(), pet.pet_region)
                QTest.qWait(round((pet.expression_spec["blinkInterval"][1]+.3)*1000))
                self.assertTrue(any(key.startswith("2:") for key in expressions))
                self.assertTrue(any(key.endswith(":"+str(-pet.expression_spec["swaySteps"])) for key in expressions))
                self.assertTrue(any(key.endswith(":"+str(pet.expression_spec["swaySteps"])) for key in expressions))
                self.assertGreater(pet.blink_at, pet.expression_time)
                QTest.qWait(int(module.PATROL_START*1000)+150)
                x = pet.position_x; QTest.qWait(200)
                self.assertTrue(pet.position_x < x and pet.region_key[0] == "walk")
                point = QPoint(100, 80)
                self.assertTrue(pet.hit_pet(point))
                self.assertFalse(pet.hit_pet(QPoint(1, 1)))
                self.assertLess(pet.caption_opacity, .02)
                QTest.mouseClick(pet, Qt.MouseButton.LeftButton, pos=QPoint(1, 1))
                QTest.qWait(550)
                self.assertIsNone(pet.local_action)
                QTest.mouseClick(pet, Qt.MouseButton.LeftButton, pos=point)
                QApplication.sendEvent(pet, QEvent(QEvent.Type.UngrabMouse))
                QTest.qWait(QApplication.doubleClickInterval()+80)
                self.assertEqual(pet.local_action, "happy")
                QTest.qWait(1800)
                self.assertIsNone(pet.local_action)
                self.assertLess(pet.caption_opacity, .12)
                QTest.mouseClick(pet, Qt.MouseButton.LeftButton, pos=point)
                QTest.mouseDClick(pet, Qt.MouseButton.LeftButton, pos=point)
                QTest.mouseRelease(pet, Qt.MouseButton.LeftButton, pos=point)
                QTest.qWait(80)
                self.assertEqual(pet.local_action, "wave")
                self.assertEqual(pet.region_key[0], "wave")
                QTest.mousePress(pet, Qt.MouseButton.LeftButton, pos=point)
                QTest.qWait(750)
                self.assertEqual(pet.local_action, "rest")
                QTest.mouseRelease(pet, Qt.MouseButton.LeftButton, pos=point)
                self.assertEqual(pet.pending_click, 0)
                QTest.mousePress(pet, Qt.MouseButton.LeftButton, pos=point)
                QTest.mouseMove(pet, QPoint(75, 65))
                x = pet.position_x; QTest.qWait(200)
                self.assertEqual(pet.position_x, x)
                QTest.mouseRelease(pet, Qt.MouseButton.LeftButton, pos=QPoint(75, 65))
                QTest.qWait(550)
                self.assertIsNone(pet.local_action)
                self.assertEqual(pet.pending_click, 0)
                QTest.qWait(int(module.PATROL_START*1000)); x = pet.position_x; QTest.qWait(200)
                self.assertTrue(pet.position_x < x and pet.region_key[0] == "walk")
                for paused in (True, False):
                    QTimer.singleShot(80, lambda: QTest.keyClick(QApplication.activePopupWidget(), Qt.Key.Key_Return))
                    QTimer.singleShot(40, lambda: QApplication.activePopupWidget().setActiveAction(QApplication.activePopupWidget().actions()[0]))
                    pet.contextMenuEvent(QContextMenuEvent(QContextMenuEvent.Reason.Mouse, point, pet.mapToGlobal(point)))
                    x = pet.position_x; QTest.qWait(int(module.PATROL_START*1000)+250)
                    self.assertEqual(pet.position_x == x, paused)
                    if paused:
                        composite = pet.composite.cacheKey(); QTest.qWait(100)
                        self.assertEqual((pet.gaze_x, pet.gaze_y), (0, 0))
                        self.assertEqual(pet.composite.cacheKey(), composite)
                        self.assertEqual((pet.expression_key, pet.blink_at), ("0:0", None))
                QTest.mousePress(pet, Qt.MouseButton.LeftButton, pos=point)
                QApplication.sendEvent(pet, QEvent(QEvent.Type.WindowDeactivate))
                QTest.qWait(750)
                self.assertIsNone(pet.press_point)
                self.assertIsNone(pet.local_action)
                for value in ("working", "thinking", "replying", "waiting", "failed", "working", "idle"):
                    state.write_text(json.dumps({"state": value}))
                    QTest.qWait(180)
                    self.assertEqual(pet.state, value)
                    self.assertEqual(pet.region_key[0], module.STREAM_ANIMATION.get(value, value))
                state.write_text('{"state":')
                QTest.qWait(150)
                self.assertEqual(pet.state, "idle")
                QTest.mousePress(pet, Qt.MouseButton.LeftButton, pos=point)
                pet.showMinimized(); QTest.qWait(100)
                self.assertIsNone(pet.press_point)
                self.assertFalse(pet.frame_timer.isActive())
                self.assertEqual((pet.expression_key, pet.blink_at), ("0:0", None))
                QTest.mouseRelease(pet, Qt.MouseButton.LeftButton, pos=point)
                pet.showNormal(); QTest.qWait(100)
                self.assertTrue(pet.frame_timer.isActive())
                self.assertLess(pet.expression_time, 1)
                self.assertGreater(pet.blink_at, pet.expression_time)
                self.assertEqual(pet.pending_click, 0)
                pet.hide()
                self.assertFalse(pet.frame_timer.isActive())
                pet.show()
                self.assertTrue(pet.frame_timer.isActive())
                QTest.mouseClick(pet, Qt.MouseButton.LeftButton, pos=point)
                state.unlink()  # Actual consumer closes itself; no manual cleanup before assertions.
                QTest.qWait(180)
                self.assertFalse(pet.isVisible())
                self.assertFalse(pet.state_timer.isActive())
                self.assertFalse(pet.frame_timer.isActive())
                self.assertEqual(pet.pending_click, 0)
                self.assertEqual((pet.expression_key, pet.blink_at), ("0:0", None))
            finally:
                observer.stop()
                pet.close()


if __name__ == "__main__":
    unittest.main()
