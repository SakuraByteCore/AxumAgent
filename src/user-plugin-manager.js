import fs from "fs";
import path from "path";
import os from "os";

/**
 * User Plugin Manager
 * 
 * Provides utilities for creating, listing, and managing user-defined plugins.
 * User plugins are stored in ~/.axum/plugins/ and automatically loaded by Pi.
 */

export function getUserPluginsDir() {
  const homeDir = process.env.HOME || os.homedir();
  return path.join(homeDir, ".axum", "plugins");
}

export function getProjectPluginsDir(cwd = process.cwd()) {
  return path.join(cwd, "axum-plugins");
}

/**
 * Create a new plugin from template
 * @param {string} name - Plugin name (e.g., "electron-cdp")
 * @param {object} options - Creation options
 * @param {boolean} options.project - Create in project plugins dir instead of user
 * @returns {string} - Path to created plugin directory
 */
export function createPluginTemplate(name, options = {}) {
  const pluginsDir = options.project ? getProjectPluginsDir(options.cwd) : getUserPluginsDir();
  const pluginDir = path.join(pluginsDir, name);
  
  if (fs.existsSync(pluginDir)) {
    throw new Error(`Plugin directory already exists: ${pluginDir}`);
  }
  
  fs.mkdirSync(pluginDir, { recursive: true });
  
  // Generate package.json
  const packageJson = {
    name: `axum-plugin-${name}`,
    version: "0.1.0",
    type: "module",
    main: "index.ts",
    description: `Custom Axum plugin: ${name}`,
  };
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify(packageJson, null, 2) + "\n"
  );
  
  // Generate index.ts template
  const indexTemplate = `import type { Extension } from '@earendil-works/pi-coding-agent';

/**
 * ${name} Plugin
 * 
 * Custom Axum plugin created by user.
 */

export const extension: Extension = {
  name: '${name}',
  version: '0.1.0',
  
  activate(ctx) {
    console.log('[${name}] Plugin activated');
    
    // Example: Register a tool
    ctx.tool({
      name: '${name.replace(/-/g, "_")}_hello',
      description: 'Example tool from ${name} plugin',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message to echo' }
        },
        required: ['message']
      },
      async execute(input) {
        return {
          content: [{
            type: 'text',
            text: \`Hello from ${name}: \${input.message}\`
          }]
        };
      }
    });
    
    // Example: Register a command
    ctx.command({
      name: '/${name}',
      description: 'Example command from ${name} plugin',
      async execute(args) {
        ctx.ui.writeLine(\`/${name} command executed with args: \${args}\`);
      }
    });
  },
  
  deactivate() {
    console.log('[${name}] Plugin deactivated');
  }
};

export default extension;
`;
  fs.writeFileSync(path.join(pluginDir, "index.ts"), indexTemplate);
  
  // Generate README.md
  const readmeTemplate = `# ${name}

Custom Axum plugin.

## Installation

This plugin is automatically loaded from:
${options.project ? '- Project plugins: `./axum-plugins/' + name + '`' : '- User plugins: `~/.axum/plugins/' + name + '`'}

## Usage

### Tool: \`${name.replace(/-/g, "_")}_hello\`

\`\`\`
Use the ${name.replace(/-/g, "_")}_hello tool with message "test"
\`\`\`

### Command: \`/${name}\`

\`\`\`
/${name} [args]
\`\`\`

## Development

Edit \`index.ts\` to implement your plugin logic.

Restart Axum to reload the plugin:
\`\`\`bash
axum code
\`\`\`

## API Reference

See [@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) for full Extension API documentation.
`;
  fs.writeFileSync(path.join(pluginDir, "README.md"), readmeTemplate);
  
  return pluginDir;
}

/**
 * List all available plugins (user + project + bundled)
 * @param {object} options - List options
 * @returns {Array} - Plugin list with metadata
 */
export function listAllPlugins(options = {}) {
  const { getUserPluginPaths, getProjectPluginPaths, supportedBundledPiExtensions } = 
    require("./bundled-pi-platform.js");
  
  const userPlugins = getUserPluginPaths(options).map((p) => ({
    name: p.packageName,
    source: "user",
    path: p.extensionPath,
    enabled: true,
  }));
  
  const projectPlugins = getProjectPluginPaths(options).map((p) => ({
    name: p.packageName,
    source: "project",
    path: p.extensionPath,
    enabled: true,
  }));
  
  const bundledPlugins = supportedBundledPiExtensions(options).map((p) => ({
    name: p.packageName,
    source: "bundled",
    path: p.extensionPath,
    enabled: true,
  }));
  
  return [...projectPlugins, ...userPlugins, ...bundledPlugins];
}

/**
 * Format plugin list for display
 * @param {Array} plugins - Plugin list from listAllPlugins
 * @returns {string} - Formatted output
 */
export function formatPluginList(plugins) {
  const grouped = {
    project: plugins.filter((p) => p.source === "project"),
    user: plugins.filter((p) => p.source === "user"),
    bundled: plugins.filter((p) => p.source === "bundled"),
  };
  
  const lines = [];
  
  if (grouped.project.length > 0) {
    lines.push("Project Plugins (./axum-plugins/):");
    grouped.project.forEach((p) => {
      lines.push(`  - ${p.name} ${p.enabled ? "✓" : "✗"}`);
    });
    lines.push("");
  }
  
  if (grouped.user.length > 0) {
    lines.push("User Plugins (~/.axum/plugins/):");
    grouped.user.forEach((p) => {
      lines.push(`  - ${p.name} ${p.enabled ? "✓" : "✗"}`);
    });
    lines.push("");
  }
  
  if (grouped.bundled.length > 0) {
    lines.push(`Bundled Plugins (${grouped.bundled.length} total):`);
    grouped.bundled.forEach((p) => {
      lines.push(`  - ${p.name}`);
    });
  }
  
  return lines.join("\n");
}
