# SelectList 向上箭头循环跳转修复

### 问题

在 `/usemodel` 命令的模型选择列表中，当选中第一项时按向上箭头键（↑），无法循环跳转到列表最后一项。用户期望的行为是：在列表顶部按向上箭头应该跳转到列表底部（类似 Vim 的循环导航）。

### 原因

通过深入分析 `@earendil-works/pi-tui` 包的 `SelectList` 组件，发现循环跳转的**逻辑本身已经正确实现**：

```javascript
// 原代码（逻辑正确）
if (kb.matches(keyData, "tui.select.up")) {
    this.selectedIndex = this.selectedIndex === 0 
        ? this.filteredItems.length - 1  // 在第一项时跳转到最后一项
        : this.selectedIndex - 1;
    this.notifySelectionChange();
}
```

但问题在于 `handleInput()` 方法**缺少返回值**。当按键事件被处理后，方法没有返回 `true` 来通知父组件或渲染层需要刷新界面。导致虽然内部索引已更新，但界面未及时重绘，给用户造成"跳转失败"的错觉。

此外，缺少调试日志使得按键事件的接收与处理过程完全不可见，无法快速定位问题根源。

### 修改点

**目标文件**：`~/.cache/axum-agent/bundled-pi/v4/android-arm64/pi-da11b57995b3/node_modules/@earendil-works/pi-tui/dist/components/select-list.js`

**核心修改**（`handleInput` 方法）：

1. **添加调试日志**（通过 `PI_TUI_DEBUG` 环境变量控制）
   - 记录接收到的原始按键数据及其十六进制表示
   - 记录索引变更轨迹（前一个索引 → 当前索引 / 总数）

2. **补充返回值**
   - 所有按键匹配分支（`up`、`down`、`confirm`、`cancel`）处理后返回 `true`
   - 无匹配时返回 `false`
   - 确保父组件能正确响应按键处理结果并触发重渲染

3. **增强向上/向下箭头分支**
   - 保存 `prevIndex` 用于调试日志输出
   - 在调试模式下输出完整的状态转换信息

**修改后的关键代码片段**：

```javascript
handleInput(keyData) {
    const kb = getKeybindings();
    
    // 调试日志
    if (process.env.PI_TUI_DEBUG) {
        console.error(`[SelectList] Key received: ${JSON.stringify(keyData)}, hex: ${Buffer.from(keyData).toString('hex')}`);
    }
    
    // 向上箭头 - 循环到底部
    if (kb.matches(keyData, "tui.select.up")) {
        const prevIndex = this.selectedIndex;
        this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
        this.notifySelectionChange();
        if (process.env.PI_TUI_DEBUG) {
            console.error(`[SelectList] Up arrow: ${prevIndex} -> ${this.selectedIndex} (total: ${this.filteredItems.length})`);
        }
        return true; // ← 新增：通知父组件重渲染
    }
    
    // 其他分支同样补充 return true
    // ...
    
    return false; // 无匹配时返回 false
}
```

**涉及文件清单**：
- 核心修复：`node_modules/@earendil-works/pi-tui/dist/components/select-list.js`
- 补丁文件：`patches/select-list-wrap-fix.patch`
- 测试用例：`tests/select-list-wrap-test.js`
- 技术归档：`docs/fixes/select-list-arrow-key-wrap.md`（本文件）

### 预期结果

修复后，用户在 `/usemodel` 列表中的体验为：

1. **循环跳转生效**：在第一项按向上箭头，立即跳转到最后一项；在最后一项按向下箭头，立即跳转到第一项
2. **界面实时更新**：选中项高亮正确移动，不会出现延迟或"卡住"现象
3. **调试能力增强**：设置 `PI_TUI_DEBUG=1` 后，可在 stderr 观察到详细的按键接收与处理日志，便于后续问题排查

**验证方式**：

```bash
# 方式 1：直接测试
pi /usemodel
# 在列表中按向上箭头，观察是否从第一项跳到最后一项

# 方式 2：启用调试模式
PI_TUI_DEBUG=1 pi /usemodel
# 观察终端 stderr 输出的按键事件日志

# 方式 3：运行单元测试
node tests/select-list-wrap-test.js
# 验证循环跳转逻辑的所有边界情况
```

**技术细节**：

- 箭头键在终端中的转义序列：向上 `\x1b[A`，向下 `\x1b[B`
- Pi TUI 使用 `@earendil-works/pi-tui` 包的 `getKeybindings()` 和 `matchesKey()` 进行跨终端兼容的按键检测
- 默认键位绑定：`tui.select.up` → `"up"`，`tui.select.down` → `"down"`
- `notifySelectionChange()` 只负责通知外部监听器，不负责触发组件自身重渲染；必须通过返回值让调用者决定渲染策略
