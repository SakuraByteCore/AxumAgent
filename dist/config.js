"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.expandHome = expandHome;
exports.defaultConfigPath = defaultConfigPath;
exports.resolveConfigPath = resolveConfigPath;
exports.loadConfig = loadConfig;
exports.selectedProvider = selectedProvider;
exports.resolveSecret = resolveSecret;
exports.numberFromConfig = numberFromConfig;
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const toml_1 = require("@iarna/toml");
const DEFAULT_CONFIG_PATH = path_1.default.join(os_1.default.homedir(), ".axum", "config.toml");
function expandHome(filePath) {
    if (filePath === "~")
        return os_1.default.homedir();
    if (filePath.startsWith("~/"))
        return path_1.default.join(os_1.default.homedir(), filePath.slice(2));
    return filePath;
}
function defaultConfigPath() {
    return DEFAULT_CONFIG_PATH;
}
function resolveConfigPath(env, explicitPath) {
    return path_1.default.resolve(expandHome(explicitPath || env.AXUM_CONFIG || DEFAULT_CONFIG_PATH));
}
function loadConfig(env, explicitPath) {
    const configPath = resolveConfigPath(env, explicitPath);
    if (!fs_1.default.existsSync(configPath))
        return undefined;
    const raw = fs_1.default.readFileSync(configPath, "utf8");
    const parsed = (0, toml_1.parse)(raw);
    return { path: configPath, config: parsed };
}
function selectedProvider(config) {
    const id = config?.provider || "openai-chat";
    return { id, config: config?.providers?.[id] };
}
function resolveSecret(value, env) {
    if (!value)
        return undefined;
    if (value.startsWith("env:"))
        return env[value.slice(4)];
    return value;
}
function numberFromConfig(value) {
    return typeof value === "number" ? value : undefined;
}
