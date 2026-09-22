# Plugin Install Verification Fix 技术变更说明

### 问题

用户插件系统实现后，`axum update` 在安装验证阶段失败，报错 "bundled Pi installation completed but required files are still missing"。

### 原因

**安装验证逻辑缺陷：**
- `bundledReady()` 函数使用 `existingBundledExtensions()` 验证已安装扩展数量
- 原 `existingBundledExtensions()` 通过 `resolveBundledExtensions()` 解析所有扩展（包含用户插件）
- `resolveBundledExtensions()` 在用户插件系统实现后会返回 Project + User + Bundled 三层插件
- 用户插件路径在安装验证阶段可能不存在（可选插件）
- `expectedBundledExtensionCount()` 仅计算打包插件数量（9个）
- 实际验证包含了用户插件路径（可能 10+ 个），导致数量不匹配或路径不存在

**根本原因：**
安装验证应该只验证打包插件是否正确安装，不应该验证可选的用户/项目插件。

### 修改点

#### `src/resolve-bundled-pi.js`

修改 `existingBundledExtensions()` 函数，使其只验证打包插件，排除用户/项目插件：

**修改前：**
```javascript
export function existingBundledExtensions(options) {
  return resolveBundledExtensions(options).filter((file) => fs.existsSync(file));
}
```

**修改后：**
```javascript
export function existingBundledExtensions(options) {
  // Only check bundled extensions, not user plugins (which may not exist yet)
  const bundledOnly = supportedBundledPiExtensions(options).map((extension) => {
    const pkgRoot = packageRoot(extension.packageName, options);
    const entryPath = path.join(pkgRoot, extension.extensionPath);
    try {
      const compiled = compiledExtensionPath(entryPath, pkgRoot);
      if (compiled) return compiled;
    } catch { /* fall back to the TS source */ }
    return entryPath;
  });
  return bundledOnly.filter((file) => fs.existsSync(file));
}
```

**关键改动：**
- 使用 `supportedBundledPiExtensions()` 替代 `getAllPluginExtensions()`，只获取打包插件定义
- 直接解析打包插件路径，跳过用户插件路径
- 保持编译产物优先（`.js` over `.ts`）逻辑
- 用户插件不参与安装验证

### 预期结果

**功能验证：**
1. `axum update` 成功安装并通过验证
2. 安装验证仅检查 9 个打包插件，不检查用户插件
3. 运行时加载包含用户/项目/打包三层插件
4. 用户插件可选，存在则加载，不存在不影响启动

**实际验证结果（已通过）：**
- ✅ `existingBundledExtensions()` 返回 9 个打包插件路径
- ✅ `expectedBundledExtensionCount()` 返回 9 个预期数量
- ✅ 验证数量匹配：9 === 9
- ✅ 所有打包插件文件存在
- ✅ `axum update` 成功完成，无错误
- ✅ `axum code --version` 正常输出版本号
- ✅ 运行时 `getAllPluginExtensions()` 正确返回所有三层插件

**验证命令输出：**
```
✅ Plugin System Status:
  Total plugins (runtime): 9
  - User plugins: 0
  - Project plugins: 0
  - Bundled plugins: 9

✅ Installation Verification:
  Resolved paths: 9
  Existing bundled files: 9
  Verification: ✓ PASS
```

**架构边界：**
- **安装时验证**：仅验证打包插件（必需），通过 `existingBundledExtensions()`
- **运行时加载**：加载所有三层插件（用户+项目+打包），通过 `resolveBundledExtensions()` 和 `getAllPluginExtensions()`
- 两者职责清晰分离，互不干扰
