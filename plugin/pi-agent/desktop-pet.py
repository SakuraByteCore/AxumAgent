#!/usr/bin/env python3
"""macOS/Linux 桌面宠物；播放共用纸偶精灵帧，肢体与表情在素材中独立变化。"""

import json
import math
import random
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import time

try:
    from PySide6.QtCore import QEvent, QPoint, QRect, QRectF, Qt, QTimer
    from PySide6.QtGui import QColor, QCursor, QGuiApplication, QImage, QPainter, QPixmap, QRegion
    from PySide6.QtWidgets import QApplication, QMenu, QWidget
except ModuleNotFoundError as error:
    if not (error.name or "").startswith("PySide6"):
        raise
    print("桌面宠物需要 PySide6，请安装：python3 -m pip install PySide6", file=sys.stderr)
    sys.exit(1)

WINDOW_WIDTH = 200
WINDOW_HEIGHT = 230
IMAGE_SIZE = 160
IMAGE_CENTER_Y = 94
LABEL_TOP = 184
LABEL_HEIGHT = 34
SCREEN_MARGIN = 20
STATE_INTERVAL_MS = 100
FRAME_INTERVAL_MS = 33
MAX_FRAME_SECONDS = 0.1
GAZE_SETTLE_EPSILON = 0.001  # Less than 0.01 output pixel at the head perimeter.
PATROL_SPEED = 7.0
PATROL_PERIOD = 20.0
PATROL_START = 4.0
PATROL_END = 14.0
ACTION_SECONDS = 1.6
HOLD_SECONDS = 0.65
DRAG_THRESHOLD = 5
LABELS = {
    "idle": "陪你一起，慢慢来",
    "working": "正在处理任务…",
    "thinking": "正在思考…",
    "replying": "正在回复…",
    "waiting": "等你确认一下",
    "failed": "任务遇到问题 · 请看主窗口",
}
COLORS = {"idle": "#654f49", "working": "#14532d", "thinking": "#14532d",
          "replying": "#14532d", "waiting": "#854d0e", "failed": "#9f1239"}
STREAM_ANIMATION = {"thinking": "waiting", "replying": "working"}


def reduced_motion_requested():
    """读取可查询的平台设置；不可查询时保留菜单手动控制。"""
    if sys.platform == "darwin":
        preferences = Path.home() / "Library/Preferences/com.apple.universalaccess.plist"
        try:
            with preferences.open("rb") as source:
                return bool(plistlib.load(source).get("reduceMotion", False))
        except (OSError, plistlib.InvalidFileException):
            return False
    settings = shutil.which("gsettings")
    if settings:
        try:
            result = subprocess.run(
                [settings, "get", "org.gnome.desktop.interface", "enable-animations"],
                capture_output=True, text=True, timeout=1, check=False,
            )
            return result.returncode == 0 and result.stdout.strip() == "false"
        except (OSError, subprocess.TimeoutExpired):
            return False
    return False


def parent_exists(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class DesktopPet(QWidget):
    def __init__(self, state_path, image_path, parent_pid):
        super().__init__()
        self.state_path = Path(state_path)
        self.parent_pid = parent_pid
        asset = Path(image_path).parent
        self.atlas_spec = json.loads((asset / "desktop-pet-atlas.json").read_text())
        motion = asset / "desktop-pet-motion"
        self.motion_spec = json.loads((motion / "motion.json").read_text())
        self.image = QPixmap(str(motion / "body.png"))
        self.head_image = QPixmap(str(motion / "head.png"))
        if self.image.isNull() or self.head_image.isNull():
            raise ValueError("无法加载桌面宠物分层 PNG")
        expression = asset / "desktop-pet-expression"
        self.expression_spec = json.loads((expression / "expression.json").read_text())
        self.expression_images = {key: QPixmap(str(expression / item["file"]))
                                  for key, item in self.expression_spec["variants"].items()}
        if any(image.isNull() for image in self.expression_images.values()):
            raise ValueError("无法加载桌面宠物局部动画 PNG")
        self.reset_expression()
        self.state = "idle"
        self.epoch = time.monotonic()
        self.last_frame = self.epoch
        self.greeting_start = None
        self.drag_offset = None
        self.press_point = None
        self.pressed_at = 0.0
        self.pending_click = 0.0
        self.long_pressed = False
        self.double_pressed = False
        self.local_action = None
        self.action_until = 0.0
        self.caption_opacity = 0.0
        self.caption_text = ""
        self.gaze_x = self.gaze_y = 0.0
        self.target_x = self.target_y = 0.0
        self.direction = -1
        self.paused = reduced_motion_requested()
        self.menu_open = False
        self.setWindowFlags(Qt.WindowType.Tool | Qt.WindowType.FramelessWindowHint
                            | Qt.WindowType.WindowStaysOnTopHint
                            | Qt.WindowType.WindowDoesNotAcceptFocus)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        self.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.setFixedSize(WINDOW_WIDTH, WINDOW_HEIGHT)
        self.setMouseTracking(True)
        self.composite_key = None
        self.pet_region = QRegion()
        screen = QGuiApplication.screenAt(QCursor.pos()) or QGuiApplication.primaryScreen()
        bounds = screen.availableGeometry()
        self.position_x = float(bounds.right() - WINDOW_WIDTH - SCREEN_MARGIN)
        self.position_y = float(bounds.bottom() - WINDOW_HEIGHT - SCREEN_MARGIN)
        self.clamp_position(screen)
        self.state_timer = QTimer(self)
        self.state_timer.timeout.connect(self.read_state)
        self.state_timer.start(STATE_INTERVAL_MS)
        self.frame_timer = QTimer(self)
        self.frame_timer.timeout.connect(self.animate_frame)
        self.frame_timer.start(FRAME_INTERVAL_MS)

    def compose_frame(self):
        frame = self.animation_frame()
        key = (self.region_key, self.gaze_x, self.gaze_y, self.expression_key)
        if key == self.composite_key:
            return
        size = self.motion_spec["frameSize"]
        canvas = QPixmap(size, size)
        canvas.fill(Qt.GlobalColor.transparent)
        painter = QPainter(canvas)
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        rect = QRectF(0, 0, size, size)
        painter.drawPixmap(rect, self.image, frame)
        px, py = self.motion_spec["pivot"]
        scale = self.motion_spec["translationScale"]
        painter.translate(px + self.gaze_x*scale, py + self.gaze_y*scale)
        painter.rotate(self.gaze_x*self.motion_spec["rotationPerX"])
        painter.translate(-px, -py)
        head, head_frame = self.head_image, frame
        if self.expression_key != "0:0":
            action, index = self.region_key
            variant = self.expression_spec["variants"][self.expression_key]
            head = self.expression_images[self.expression_key]
            head_frame = QRectF(variant["frames"][action][index]*size, 0, size, size)
        painter.drawPixmap(rect, head, head_frame)
        painter.end()
        self.composite = canvas.scaled(IMAGE_SIZE, IMAGE_SIZE, Qt.AspectRatioMode.IgnoreAspectRatio,
                                       Qt.TransformationMode.SmoothTransformation)
        pixels = self.composite.toImage().convertToFormat(QImage.Format.Format_RGBA8888)
        alpha = bytes(pixels.constBits())[3::4]
        region = QRegion()
        for y in range(IMAGE_SIZE):
            for run in re.finditer(rb"[\x19-\xff]+", alpha[y*IMAGE_SIZE:(y+1)*IMAGE_SIZE]):
                region |= QRegion(QRect((WINDOW_WIDTH-IMAGE_SIZE)//2+run.start(),
                                        IMAGE_CENTER_Y-IMAGE_SIZE//2+y, run.end()-run.start(), 1))
        self.pet_region = region
        self.composite_key = key

    def reset_expression(self):
        self.expression_time = 0.0
        self.blink_at = None
        self.expression_key = "0:0"

    def animate_expression(self, delta, active):
        if not active:
            self.reset_expression()
            return
        self.expression_time += delta
        if self.blink_at is None:
            self.blink_at = self.expression_time + random.uniform(*self.expression_spec["blinkInterval"])
        phase = (self.expression_time-self.blink_at)/self.expression_spec["blinkSeconds"]
        blink = 0
        if phase >= 1:
            self.blink_at = self.expression_time + random.uniform(*self.expression_spec["blinkInterval"])
        elif phase >= 0:
            blink = 2 if self.expression_spec["blinkHold"][0] <= phase <= self.expression_spec["blinkHold"][1] else 1
        wave = math.sin(math.tau*self.expression_time/self.expression_spec["swayPeriod"])
        sway = round(wave*self.expression_spec["swaySteps"])
        self.expression_key = f"{blink}:{sway}"

    def read_state(self):
        if not parent_exists(self.parent_pid):
            self.close()
            return
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8-sig"))
        except FileNotFoundError:
            self.close()
            return
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            return  # 写入过程中保留上次完整状态。
        if not isinstance(data, dict):
            return
        state = data.get("state")
        if not isinstance(state, str) or state not in LABELS or state == self.state:
            return
        self.state = state
        self.reset_expression()
        self.epoch = time.monotonic()
        self.greeting_start = None
        self.local_action = None
        self.action_until = 0.0
        self.cancel_gesture()
        self.update()

    def current_screen(self):
        center = QPoint(round(self.position_x + WINDOW_WIDTH / 2),
                        round(self.position_y + WINDOW_HEIGHT / 2))
        return (QGuiApplication.screenAt(center) or self.screen()
                or QGuiApplication.primaryScreen())

    def clamp_position(self, screen=None):
        # Qt availableGeometry 对应屏幕可用工作区；窗口管理器可能限制定位。
        bounds = (screen or self.current_screen()).availableGeometry()
        maximum_x = max(bounds.left(), bounds.right() + 1 - WINDOW_WIDTH)
        maximum_y = max(bounds.top(), bounds.bottom() + 1 - WINDOW_HEIGHT)
        clamped_x = min(max(self.position_x, bounds.left()), maximum_x)
        self.position_y = min(max(self.position_y, bounds.top()), maximum_y)
        if clamped_x != self.position_x:
            self.direction *= -1
        self.position_x = clamped_x
        self.move(round(self.position_x), round(self.position_y))

    def cancel_gesture(self):
        self.press_point = None
        self.drag_offset = None
        self.pending_click = 0.0

    def start_action(self, action, now):
        self.local_action = action
        self.greeting_start = now
        self.action_until = now + ACTION_SECONDS

    def patrolling(self, now):
        phase = (now - self.epoch) % PATROL_PERIOD
        return (not self.paused and not self.menu_open and not self.isMinimized()
                and self.press_point is None and self.drag_offset is None
                and not self.pending_click and now >= self.action_until
                and self.state == "idle" and PATROL_START <= phase <= PATROL_END)

    def animate_frame(self):
        now = time.monotonic()
        delta = min(now - self.last_frame, MAX_FRAME_SECONDS)
        self.last_frame = now
        if self.pending_click and now >= self.pending_click:
            self.pending_click = 0.0
            self.start_action("happy", now)
        if (self.press_point is not None and self.drag_offset is None
                and not self.long_pressed and not self.double_pressed
                and now - self.pressed_at >= HOLD_SECONDS):
            self.long_pressed = True
            self.start_action("rest", now)
        if now >= self.action_until:
            self.local_action = None
            self.greeting_start = None
        text = "" if self.state == "idle" else LABELS[self.state]
        if self.local_action and self.state == "idle":
            text = {"happy": "我在呢，陪着你！", "wave": "你好呀～ 很高兴见到你",
                    "rest": "靠一会儿～ 慢慢来"}[self.local_action]
        if text:
            self.caption_text = text
        self.caption_opacity += (bool(text) - self.caption_opacity) * min(1, delta*9)
        active = not self.paused and not self.menu_open and not self.isMinimized()
        self.animate_expression(delta, active and self.drag_offset is None and self.press_point is None)
        tx, ty = (self.target_x, self.target_y) if active else (0, 0)
        self.gaze_x += (tx - self.gaze_x) * min(1, delta*8)
        self.gaze_y += (ty - self.gaze_y) * min(1, delta*8)
        if abs(tx - self.gaze_x) < GAZE_SETTLE_EPSILON:
            self.gaze_x = tx
        if abs(ty - self.gaze_y) < GAZE_SETTLE_EPSILON:
            self.gaze_y = ty
        if self.patrolling(now):
            self.position_x += self.direction * PATROL_SPEED * delta
        if self.drag_offset is None:
            self.clamp_position()
        self.update()

    def animation_frame(self):
        elapsed = time.monotonic() - self.epoch
        active = (not self.paused and self.drag_offset is None and not self.menu_open
                  and not self.isMinimized())
        action = STREAM_ANIMATION.get(self.state, self.state)
        if self.local_action:
            action = {"wave": "wave", "happy": "idle", "rest": "waiting"}[self.local_action]
            elapsed = time.monotonic() - self.greeting_start
        elif self.patrolling(time.monotonic()):
            action = "walk"
        spec = self.atlas_spec["animations"][action]
        index = int(elapsed * spec["fps"]) % spec["frames"] if active else 0
        self.region_key = (action, index)
        size = self.atlas_spec["frameSize"]
        return QRectF(index*size, spec["row"]*size, size, size)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        self.compose_frame()
        painter.drawPixmap((WINDOW_WIDTH-IMAGE_SIZE)//2, IMAGE_CENTER_Y-IMAGE_SIZE//2, self.composite)
        region_key = (self.composite_key, self.caption_opacity > .02)
        if region_key != getattr(self, "last_region_key", None):
            region = QRegion(self.pet_region)
            if self.caption_opacity > .02:
                region |= QRegion(QRect(14, LABEL_TOP, WINDOW_WIDTH-28, LABEL_HEIGHT))
                region |= QRegion(QRect(2, LABEL_TOP+12, WINDOW_WIDTH-4, LABEL_HEIGHT-24))
                for x in (2, WINDOW_WIDTH-26):
                    for y in (LABEL_TOP, LABEL_TOP+LABEL_HEIGHT-24):
                        region |= QRegion(QRect(x, y, 24, 24), QRegion.RegionType.Ellipse)
            self.setMask(region)
            self.last_region_key = region_key
        painter.setOpacity(self.caption_opacity)
        label = QRectF(2, LABEL_TOP, WINDOW_WIDTH - 4, LABEL_HEIGHT)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(255, 255, 255, 225))
        painter.drawRoundedRect(label, 12, 12)
        painter.setPen(QColor(COLORS[self.state]))
        font = painter.font()
        font.setPixelSize(13)
        painter.setFont(font)
        text = painter.fontMetrics().elidedText(self.caption_text, Qt.TextElideMode.ElideRight, WINDOW_WIDTH-20)
        painter.drawText(label, Qt.AlignmentFlag.AlignCenter, text)

    def hit_pet(self, point):
        return self.pet_region.contains(point)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and self.hit_pet(event.position().toPoint()):
            self.press_point = event.globalPosition().toPoint()
            self.press_origin = self.pos()
            self.pressed_at = time.monotonic()
            self.pending_click = 0.0
            self.long_pressed = self.double_pressed = False
            event.accept()

    def mouseMoveEvent(self, event):
        self.target_x = max(-1.5, min(1.5, (event.position().x()-100)/40))
        self.target_y = max(-.8, min(.8, (event.position().y()-90)/90))
        if self.press_point is None:
            return
        delta = event.globalPosition().toPoint() - self.press_point
        if self.drag_offset is None and delta.manhattanLength() < DRAG_THRESHOLD:
            return
        self.drag_offset = delta
        self.action_until = 0.0
        position = self.press_origin + delta
        self.position_x, self.position_y = float(position.x()), float(position.y())
        self.clamp_position(QGuiApplication.screenAt(event.globalPosition().toPoint()))
        event.accept()

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and self.press_point is not None:
            if self.drag_offset is None and not self.long_pressed:
                if self.double_pressed:
                    self.start_action("wave", time.monotonic())
                else:
                    self.pending_click = time.monotonic() + QApplication.doubleClickInterval()/1000
            self.press_point = None
            self.drag_offset = None
            self.epoch = time.monotonic()
            event.accept()

    def mouseDoubleClickEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and self.hit_pet(event.position().toPoint()):
            pending = self.pending_click > 0
            self.mousePressEvent(event)
            self.double_pressed = pending
            event.accept()

    def leaveEvent(self, event):
        self.target_x = self.target_y = 0.0
        super().leaveEvent(event)

    def event(self, event):
        if hasattr(self, "press_point"):
            cancel = event.type() in (QEvent.Type.WindowDeactivate, QEvent.Type.Hide,
                                      QEvent.Type.WindowStateChange)
            lost_capture = event.type() == QEvent.Type.UngrabMouse and self.press_point is not None
            if cancel or lost_capture:
                self.reset_expression()
                self.cancel_gesture()
                self.local_action = self.greeting_start = None
                self.action_until = 0.0
        return super().event(event)

    def changeEvent(self, event):
        if event.type() == QEvent.Type.WindowStateChange:
            if self.isMinimized():
                self.frame_timer.stop()
            else:
                self.last_frame = time.monotonic()
                self.frame_timer.start(FRAME_INTERVAL_MS)
        super().changeEvent(event)

    def hideEvent(self, event):
        self.frame_timer.stop()
        super().hideEvent(event)

    def showEvent(self, event):
        self.last_frame = time.monotonic()
        if not self.isMinimized():
            self.frame_timer.start(FRAME_INTERVAL_MS)
        super().showEvent(event)

    def contextMenuEvent(self, event):
        self.cancel_gesture()
        self.action_until = 0.0
        self.menu_open = True
        self.reset_expression()
        self.update()
        menu = QMenu(self)
        pause = menu.addAction("暂停动画（减少动态效果）")
        pause.setCheckable(True)
        pause.setChecked(self.paused)
        quit_action = menu.addAction("退出桌面宠物")
        selected = menu.exec(event.globalPos())
        if selected == pause:
            self.paused = pause.isChecked()
            self.epoch = time.monotonic()
            self.greeting_start = None
            self.local_action = None
        elif selected == quit_action:
            self.close()
        self.menu_open = False
        menu.deleteLater()
        self.update()

    def closeEvent(self, event):
        self.reset_expression()
        self.cancel_gesture()
        self.state_timer.stop()
        self.frame_timer.stop()
        QApplication.instance().quit()
        event.accept()


def main():
    if len(sys.argv) != 4:
        print("用法：python3 desktop-pet.py statePath imagePath parentPid", file=sys.stderr)
        return 1
    state_path, image_path, raw_pid = sys.argv[1:]
    try:
        parent_pid = int(raw_pid)
        if parent_pid <= 0:
            raise ValueError("parentPid 必须为正整数")
        if not Path(state_path).exists() or not parent_exists(parent_pid):
            return 0
        app = QApplication(sys.argv[:1])
        pet = DesktopPet(state_path, image_path, parent_pid)
        pet.show()
        QTimer.singleShot(0, pet.read_state)
        return app.exec()
    except ValueError as error:
        print(f"桌面宠物启动失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
