"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SLASH_COMMANDS = void 0;
exports.slashCommandQuery = slashCommandQuery;
exports.slashCommandLabels = slashCommandLabels;
exports.slashCommandDisplayName = slashCommandDisplayName;
exports.matchingSlashCommands = matchingSlashCommands;
exports.clampSelection = clampSelection;
exports.completeSlashCommand = completeSlashCommand;
exports.isCompleteSlashCommand = isCompleteSlashCommand;
exports.isBareSlashCommandQuery = isBareSlashCommandQuery;
exports.renderSlashCommandSuggestions = renderSlashCommandSuggestions;
const text_1 = require("./text");
exports.SLASH_COMMANDS = [
    { name: "/help", description: "show commands" },
    { name: "/provider", description: "show/set provider url/key" },
    { name: "/providers", description: "list configured providers" },
    { name: "/model", description: "fetch/list/switch models" },
    { name: "/parallel", description: "plan sub-agent tasks" },
    { name: "/tasks", description: "show recent runtime/task state" },
    { name: "/exit", aliases: ["/quit"], description: "exit TUI" },
];
function slashCommandQuery(input) {
    if (!input.startsWith("/"))
        return "";
    return input.slice(1).trimStart().split(/\s+/)[0] ?? "";
}
function slashCommandLabels(command) {
    return [command.name, ...(command.aliases ?? [])];
}
function slashCommandDisplayName(command) {
    return slashCommandLabels(command).join(" / ");
}
function matchingSlashCommands(input) {
    if (!input.startsWith("/"))
        return [];
    const query = slashCommandQuery(input);
    return exports.SLASH_COMMANDS.filter((command) => slashCommandLabels(command).some((label) => label.slice(1).startsWith(query)));
}
function clampSelection(index, count) {
    if (count <= 0)
        return 0;
    return Math.max(0, Math.min(index, count - 1));
}
function completeSlashCommand(input, selectedIndex) {
    const matches = matchingSlashCommands(input);
    const selected = matches[clampSelection(selectedIndex, matches.length)];
    if (!selected)
        return undefined;
    const query = slashCommandQuery(input);
    const completed = slashCommandLabels(selected).find((label) => label.slice(1).startsWith(query)) ?? selected.name;
    return `${completed} `;
}
function isCompleteSlashCommand(input) {
    const trimmed = input.trim();
    return exports.SLASH_COMMANDS.some((command) => slashCommandLabels(command).includes(trimmed));
}
function isBareSlashCommandQuery(input) {
    return input.startsWith("/") && !/\s/.test(input.trim());
}
function padCell(text, width) {
    const textWidth = (0, text_1.visibleWidth)(text);
    if (textWidth <= width)
        return text + " ".repeat(width - textWidth);
    return `${(0, text_1.truncateToVisibleWidth)(text, Math.max(0, width - 1))}…`;
}
function framedSection(title, body, width) {
    const safeWidth = Math.max(24, width);
    const inner = Math.max(1, safeWidth - 4);
    const titleText = ` ${title} `;
    const top = `╭─${titleText}${"─".repeat(Math.max(0, safeWidth - (0, text_1.visibleWidth)(titleText) - 3))}`;
    const bottom = `╰${"─".repeat(Math.max(0, safeWidth - 1))}`;
    const content = body.length === 0 ? [""] : body;
    return [
        (0, text_1.clip)(top, safeWidth),
        ...content.flatMap((line) => (0, text_1.wrapPreservingShortLine)(line, inner)).map((line) => `│ ${(0, text_1.clip)(line, inner)} │`),
        (0, text_1.clip)(bottom, safeWidth),
    ];
}
function renderSlashCommandSuggestions(input, width, selectedIndex = 0) {
    if (!input.startsWith("/"))
        return [];
    const matches = matchingSlashCommands(input);
    const bodyWidth = Math.max(24, width - 4);
    if (matches.length === 0)
        return framedSection("Commands", ["no matching commands"], width);
    const selected = clampSelection(selectedIndex, matches.length);
    const labelWidth = Math.min(Math.max(...matches.map((command) => slashCommandDisplayName(command).length), 10), Math.max(10, Math.floor(bodyWidth * 0.38)));
    const rows = matches.map((command, index) => {
        const marker = index === selected ? "▸" : " ";
        const label = padCell(slashCommandDisplayName(command), labelWidth);
        return `${marker} ${label}  ${command.description}`;
    });
    return framedSection("Commands", rows, width);
}
