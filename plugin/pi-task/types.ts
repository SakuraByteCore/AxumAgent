export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type AgentSource = "builtin" | "omp" | "user" | "project";

export interface AgentProfile {
	name: string;
	description: string;
	source: AgentSource;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	systemPrompt?: string;
}

export interface TaskItem {
	name?: string;
	agent?: string;
	task: string;
}

export interface TaskExtensionOptions {
	maxWidth?: number;
	maxConcurrency?: number;
}

export interface TaskUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate?: number;
}

export type TaskStatus = "queued" | "running" | "completed" | "rejected" | "error";

export interface TaskProgressNode {
	id: string;
	label: string;
	agent: string;
	status: TaskStatus;
	startedAt: number;
	endedAt?: number;
	activity: string[];
	activityCount: number;
	result?: string;
	error?: string;
	usage?: TaskUsage;
}

export interface TaskItemResult {
	label: string;
	agent: string;
	status: Exclude<TaskStatus, "queued" | "running">;
	result?: string;
	error?: string;
	usage?: TaskUsage;
}

export interface TaskToolDetails {
	label: string;
	agent: string;
	status: TaskStatus;
	items: TaskItemResult[];
	usage?: TaskUsage;
	progress?: TaskProgressNode;
	progressItems?: TaskProgressNode[];
	error?: string;
}
