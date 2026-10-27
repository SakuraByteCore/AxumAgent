#!/usr/bin/env python3
"""macOS/Linux 桌面宠物；播放共用纸偶精灵帧，肢体与表情在素材中独立变化。"""

import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time

try:
    from PySide6.QtCore import QPoint, QRectF, Qt, QTimer
    from PySide6.QtGui import QColor, QCursor, QGuiApplication, QPainter, QPixmap
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
PATROL_SPEED = 7.0
PATROL_PERIOD = 20.0
PATROL_START = 4.0
PATROL_END = 14.0
GREETING_SECONDS = 1.2
LABELS = {
    "idle": "陪你一起，慢慢来",
    "working": "正在努力工作…",
    "waiting": "等你确认一下",
    "failed": "有点沮丧，任务出错了",
}
COLORS = {"idle": "#334155", "working": "#14532d", "waiting": "#854d0e", "failed": "#9f1239"}


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
        self.image = QPixmap(str(asset / "desktop-pet-atlas.png"))
        if self.image.isNull():
            raise ValueError("无法加载桌面宠物 PNG")
        self.state = "idle"
        self.epoch = time.monotonic()
        self.last_frame = self.epoch
        self.greeting_start = None
        self.drag_offset = None
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

    def read_state(self):
        if not parent_exists(self.parent_pid):
            self.close()
            return
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8-sig"))
        except FileNotFoundError:
            self.close()
            return
        except (json.JSONDecodeError, UnicodeDecodeError):
            return  # 写入过程中保留上次完整状态。
        if not isinstance(data, dict):
            return
        state = data.get("state")
        if not isinstance(state, str) or state not in LABELS or state == self.state:
            return
        self.state = state
        self.epoch = time.monotonic()
        self.greeting_start = None
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

    def animate_frame(self):
        now = time.monotonic()
        delta = min(now - self.last_frame, MAX_FRAME_SECONDS)
        self.last_frame = now
        if self.greeting_start is not None and now - self.greeting_start >= GREETING_SECONDS:
            self.greeting_start = None
            self.update()
        active = not self.paused and self.drag_offset is None and not self.menu_open
        phase = (now - self.epoch) % PATROL_PERIOD
        if (active and self.state == "idle" and self.greeting_start is None
                and PATROL_START <= phase <= PATROL_END):
            self.position_x += self.direction * PATROL_SPEED * delta
        if self.drag_offset is None:
            self.clamp_position()
        if active:
            self.update()

    def animation_frame(self):
        elapsed = time.monotonic() - self.epoch
        active = not self.paused and self.drag_offset is None and not self.menu_open
        action = self.state
        phase = elapsed % PATROL_PERIOD
        if active and self.greeting_start is not None:
            action = "wave"
            elapsed = time.monotonic() - self.greeting_start
        elif active and action == "idle" and PATROL_START <= phase <= PATROL_END:
            action = "walk"
        spec = self.atlas_spec["animations"][action]
        index = int(elapsed * spec["fps"]) % spec["frames"] if active else 0
        size = self.atlas_spec["frameSize"]
        return QRectF(index*size, spec["row"]*size, size, size)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        painter.drawPixmap(QRectF((WINDOW_WIDTH-IMAGE_SIZE)/2,
                                  IMAGE_CENTER_Y-IMAGE_SIZE/2, IMAGE_SIZE, IMAGE_SIZE),
                           self.image, self.animation_frame())
        label = QRectF(2, LABEL_TOP, WINDOW_WIDTH - 4, LABEL_HEIGHT)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(255, 255, 255, 225))
        painter.drawRoundedRect(label, 12, 12)
        painter.setPen(QColor(COLORS[self.state]))
        font = painter.font()
        font.setPixelSize(13)
        painter.setFont(font)
        text = "你好呀！" if self.greeting_start is not None else LABELS[self.state]
        painter.drawText(label, Qt.AlignmentFlag.AlignCenter, text)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.drag_offset = event.globalPosition().toPoint() - self.pos()
            self.greeting_start = None
            event.accept()

    def mouseMoveEvent(self, event):
        if self.drag_offset is None:
            return
        point = event.globalPosition().toPoint()
        position = point - self.drag_offset
        self.position_x, self.position_y = float(position.x()), float(position.y())
        self.clamp_position(QGuiApplication.screenAt(point))
        event.accept()

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.drag_offset = None
            self.epoch = time.monotonic()
            event.accept()

    def mouseDoubleClickEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.drag_offset = None
            self.greeting_start = time.monotonic()
            self.update()
            event.accept()

    def contextMenuEvent(self, event):
        self.menu_open = True
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
        elif selected == quit_action:
            self.close()
        self.menu_open = False
        self.update()

    def closeEvent(self, event):
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
