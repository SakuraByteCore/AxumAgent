import { clip, truncateToVisibleWidth, visibleWidth, wrapPreservingShortLine } from "./text";

export interface SlashCommandDefinition {
  name: string;
  aliases?: string[];
  description: string;
}

export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  { name: "/help", description: "show commands" },
  { name: "/provider", description: "show/set provider url/key" },
  { name: "/providers", description: "list configured providers" },
  { name: "/model", description: "fetch/list/switch models" },
  { name: "/parallel", description: "plan sub-agent tasks" },
  { name: "/tasks", description: "show recent runtime/task state" },
  { name: "/exit", aliases: ["/quit"], description: "exit TUI" },
];

export function slashCommandQuery(input: string): string {
  if (!input.startsWith("/")) return "";
  return input.slice(1).trimStart().split(/\s+/)[0] ?? "";
}

export function slashCommandLabels(command: SlashCommandDefinition): string[] {
  return [command.name, ...(command.aliases ?? [])];
}

export function slashCommandDisplayName(command: SlashCommandDefinition): string {
  return slashCommandLabels(command).join(" / ");
}

export function matchingSlashCommands(input: string): SlashCommandDefinition[] {
  if (!input.startsWith("/")) return [];
  const query = slashCommandQuery(input);
  return SLASH_COMMANDS.filter((command) => slashCommandLabels(command).some((label) => label.slice(1).startsWith(query)));
}

export function clampSelection(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(index, count - 1));
}

export function completeSlashCommand(input: string, selectedIndex: number): string | undefined {
  const matches = matchingSlashCommands(input);
  const selected = matches[clampSelection(selectedIndex, matches.length)];
  if (!selected) return undefined;
  const query = slashCommandQuery(input);
  const completed = slashCommandLabels(selected).find((label) => label.slice(1).startsWith(query)) ?? selected.name;
  return `${completed} `;
}

export function isCompleteSlashCommand(input: string): boolean {
  const trimmed = input.trim();
  return SLASH_COMMANDS.some((command) => slashCommandLabels(command).includes(trimmed));
}

export function isBareSlashCommandQuery(input: string): boolean {
  return input.startsWith("/") && !/\s/.test(input.trim());
}

function padCell(text: string, width: number): string {
  const textWidth = visibleWidth(text);
  if (textWidth <= width) return text + " ".repeat(width - textWidth);
  return `${truncateToVisibleWidth(text, Math.max(0, width - 1))}…`;
}

function framedSection(title: string, body: string[], width: number): string[] {
  const safeWidth = Math.max(24, width);
  const inner = Math.max(1, safeWidth - 4);
  const titleText = ` ${title} `;
  const top = `╭─${titleText}${"─".repeat(Math.max(0, safeWidth - visibleWidth(titleText) - 3))}`;
  const bottom = `╰${"─".repeat(Math.max(0, safeWidth - 1))}`;
  const content = body.length === 0 ? [""] : body;
  return [
    clip(top, safeWidth),
    ...content.flatMap((line) => wrapPreservingShortLine(line, inner)).map((line) => `│ ${clip(line, inner)} │`),
    clip(bottom, safeWidth),
  ];
}

export function renderSlashCommandSuggestions(input: string, width: number, selectedIndex = 0): string[] {
  if (!input.startsWith("/")) return [];
  const matches = matchingSlashCommands(input);
  const bodyWidth = Math.max(24, width - 4);
  if (matches.length === 0) return framedSection("Commands", ["no matching commands"], width);

  const selected = clampSelection(selectedIndex, matches.length);
  const labelWidth = Math.min(
    Math.max(...matches.map((command) => slashCommandDisplayName(command).length), 10),
    Math.max(10, Math.floor(bodyWidth * 0.38)),
  );
  const rows = matches.map((command, index) => {
    const marker = index === selected ? "▸" : " ";
    const label = padCell(slashCommandDisplayName(command), labelWidth);
    return `${marker} ${label}  ${command.description}`;
  });
  return framedSection("Commands", rows, width);
}
