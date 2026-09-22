# Electron CDP Plugin Example

This document demonstrates how to create a user plugin for collecting Electron main process and renderer process logs via Chrome DevTools Protocol (CDP).

## Overview

The Electron CDP plugin connects to Electron applications launched with debug flags and collects console logs for AI analysis, without modifying the application code.

## Prerequisites

1. User plugin system installed (Axum 0.1.16+)
2. Electron app launched with debug flags:
   ```bash
   electron app.js --inspect=9229 --remote-debugging-port=9222
   ```

## Installation

### Step 1: Create Plugin Template

```bash
axum code
# In the Axum session:
/plugin create electron-cdp
```

This creates `~/.axum/plugins/electron-cdp/` with:
- `package.json`
- `index.ts`
- `README.md`

### Step 2: Install Dependencies

```bash
cd ~/.axum/plugins/electron-cdp
npm install chrome-remote-interface
```

### Step 3: Implement Plugin Logic

Edit `~/.axum/plugins/electron-cdp/index.ts`:

```typescript
import type { Extension } from '@earendil-works/pi-coding-agent';
import CDP from 'chrome-remote-interface';

interface LogEntry {
  timestamp: number;
  source: 'main' | 'renderer';
  level: string;
  message: string;
  args: any[];
}

const logBuffer: LogEntry[] = [];
let mainClient: any = null;
let rendererClient: any = null;

export const extension: Extension = {
  name: 'electron-cdp',
  version: '0.1.0',
  
  async activate(ctx) {
    console.log('[electron-cdp] Plugin activated');
    
    // Tool: Connect to Electron debug ports
    ctx.tool({
      name: 'electron_cdp_connect',
      description: 'Connect to Electron debug ports and start collecting logs',
      inputSchema: {
        type: 'object',
        properties: {
          mainPort: { 
            type: 'number', 
            description: 'Main process debug port (default: 9229)',
            default: 9229
          },
          rendererPort: { 
            type: 'number', 
            description: 'Renderer process debug port (default: 9222)',
            default: 9222
          }
        }
      },
      async execute(input) {
        try {
          // Connect to main process
          mainClient = await CDP({ port: input.mainPort || 9229 });
          await mainClient.Runtime.enable();
          mainClient.Runtime.consoleAPICalled((params: any) => {
            logBuffer.push({
              timestamp: Date.now(),
              source: 'main',
              level: params.type,
              message: params.args.map((arg: any) => arg.value || arg.description).join(' '),
              args: params.args
            });
          });
          
          // Connect to renderer process
          rendererClient = await CDP({ port: input.rendererPort || 9222 });
          await rendererClient.Runtime.enable();
          rendererClient.Runtime.consoleAPICalled((params: any) => {
            logBuffer.push({
              timestamp: Date.now(),
              source: 'renderer',
              level: params.type,
              message: params.args.map((arg: any) => arg.value || arg.description).join(' '),
              args: params.args
            });
          });
          
          return {
            content: [{
              type: 'text',
              text: `✓ Connected to Electron debug ports\n  Main: ${input.mainPort || 9229}\n  Renderer: ${input.rendererPort || 9222}\n\nLog collection started. Use electron_cdp_get_logs to retrieve collected logs.`
            }]
          };
        } catch (error) {
          return {
            content: [{
              type: 'text',
              text: `✗ Connection failed: ${error.message}\n\nEnsure Electron is running with:\n  --inspect=${input.mainPort || 9229}\n  --remote-debugging-port=${input.rendererPort || 9222}`
            }],
            isError: true
          };
        }
      }
    });
    
    // Tool: Get collected logs
    ctx.tool({
      name: 'electron_cdp_get_logs',
      description: 'Retrieve collected Electron logs',
      inputSchema: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            enum: ['all', 'main', 'renderer'],
            description: 'Filter by log source (default: all)',
            default: 'all'
          },
          level: {
            type: 'string',
            enum: ['all', 'log', 'info', 'warn', 'error'],
            description: 'Filter by log level (default: all)',
            default: 'all'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of logs to return (default: 100)',
            default: 100
          }
        }
      },
      async execute(input) {
        let filtered = logBuffer;
        
        if (input.source && input.source !== 'all') {
          filtered = filtered.filter(log => log.source === input.source);
        }
        
        if (input.level && input.level !== 'all') {
          filtered = filtered.filter(log => log.level === input.level);
        }
        
        const limited = filtered.slice(-1 * (input.limit || 100));
        
        const formatted = limited.map(log => {
          const time = new Date(log.timestamp).toISOString();
          return `[${time}] [${log.source}] [${log.level}] ${log.message}`;
        }).join('\n');
        
        return {
          content: [{
            type: 'text',
            text: `Collected ${limited.length} logs:\n\n${formatted || '(no logs collected yet)'}`
          }]
        };
      }
    });
    
    // Tool: Clear log buffer
    ctx.tool({
      name: 'electron_cdp_clear_logs',
      description: 'Clear the collected log buffer',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        const count = logBuffer.length;
        logBuffer.length = 0;
        return {
          content: [{
            type: 'text',
            text: `✓ Cleared ${count} logs from buffer`
          }]
        };
      }
    });
    
    // Command: Quick status
    ctx.command({
      name: '/electron-status',
      description: 'Show Electron CDP connection status',
      async execute(args) {
        const mainStatus = mainClient ? '✓ Connected' : '✗ Disconnected';
        const rendererStatus = rendererClient ? '✓ Connected' : '✗ Disconnected';
        const logCount = logBuffer.length;
        
        ctx.ui.writeLine(`\nElectron CDP Status:`);
        ctx.ui.writeLine(`  Main process: ${mainStatus}`);
        ctx.ui.writeLine(`  Renderer process: ${rendererStatus}`);
        ctx.ui.writeLine(`  Collected logs: ${logCount}`);
        ctx.ui.writeLine(``);
      }
    });
  },
  
  async deactivate() {
    if (mainClient) await mainClient.close();
    if (rendererClient) await rendererClient.close();
    console.log('[electron-cdp] Plugin deactivated');
  }
};

export default extension;
```

### Step 4: Restart Axum

```bash
axum code
```

The plugin will be automatically loaded.

## Usage

### 1. Verify Plugin Loaded

```
/plugin list
```

Expected output:
```
User Plugins (~/.axum/plugins/):
  - electron-cdp ✓
```

### 2. Connect to Electron Debug Ports

```
Use the electron_cdp_connect tool with mainPort 9229 and rendererPort 9222
```

### 3. Collect Logs

Interact with your Electron app to generate logs, then:

```
Use the electron_cdp_get_logs tool to retrieve all logs
```

### 4. Check Status

```
/electron-status
```

### 5. Analyze Logs with AI

```
Use electron_cdp_get_logs to get error logs from the last 5 minutes, then analyze them to identify the root cause
```

## API Reference

### Tools

- **`electron_cdp_connect`**: Connect to Electron debug ports
  - `mainPort`: Main process debug port (default: 9229)
  - `rendererPort`: Renderer process debug port (default: 9222)

- **`electron_cdp_get_logs`**: Retrieve collected logs
  - `source`: Filter by `main`, `renderer`, or `all` (default: all)
  - `level`: Filter by `log`, `info`, `warn`, `error`, or `all` (default: all)
  - `limit`: Maximum logs to return (default: 100)

- **`electron_cdp_clear_logs`**: Clear the log buffer

### Commands

- **`/electron-status`**: Show connection status and log count

## Troubleshooting

### Connection Failed

Ensure Electron is launched with debug flags:
```bash
electron app.js --inspect=9229 --remote-debugging-port=9222
```

### Port Already in Use

Change the ports:
```bash
electron app.js --inspect=9230 --remote-debugging-port=9223
```

Then connect with:
```
Use electron_cdp_connect with mainPort 9230 and rendererPort 9223
```

### No Logs Collected

1. Check connection status: `/electron-status`
2. Verify Electron app is generating console output
3. Try clearing and reconnecting: `electron_cdp_clear_logs`, then reconnect

## Advanced: Project-Local Plugin

For project-specific Electron debugging, create a project-local plugin:

```bash
/plugin create-project electron-debug
```

This creates `./axum-plugins/electron-debug/`, which can include project-specific:
- Custom log parsing rules
- Application-specific error patterns
- Domain knowledge for AI analysis
- Integration with project CI/CD

Project plugins take priority over user plugins, allowing per-project customization.
