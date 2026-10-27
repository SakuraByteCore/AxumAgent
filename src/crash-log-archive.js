/**
 * pi 崩溃告警归档。
 *
 * pi 在交互界面启动时会读取 `<agentDir>/crashes.json`，对**尚未通知过**的
 * 崩溃记录弹出 "pi crashed on …" 告警。Axum 启动 pi 之前先把未通知的记录
 * 追加到 `<agentDir>/axum-crashes.json`，再把这些记录标记为已通知：
 *
 * - 用户不再看到崩溃告警；
 * - 崩溃证据不丢失——pi 自己的 crashes.json 仍然保留完整记录（/bug 仍可
 *   自动附带），Axum 侧另有一份独立归档；
 * - 归档失败不会阻断启动，本模块任何一步出错都只返回结果、不抛异常。
 */
import fs from "node:fs";
import path from "node:path";

/** 归档文件最多保留的记录数，避免无限增长。 */
const MAX_ARCHIVE_RECORDS = 50;

function readJsonArray(filePath) {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * 把 pi 的未通知崩溃记录归档到 axum-crashes.json，并标记为已通知。
 *
 * @param {string} agentDir pi 的 agent 目录（`~/.pi/agent`）
 * @returns {{ archived: number, error?: string }}
 */
export function archivePendingCrashes(agentDir) {
	const crashPath = path.join(agentDir, "crashes.json");
	const archivePath = path.join(agentDir, "axum-crashes.json");
	const records = readJsonArray(crashPath);
	if (records.length === 0) return { archived: 0 };
	const pending = records.filter((record) => record && typeof record === "object" && !record.notified);
	if (pending.length === 0) return { archived: 0 };
	try {
		// 先标记已通知：即使后续归档写入失败，pi 也不会再弹告警，且崩溃
		// 原文仍留在 pi 自己的 crashes.json 中。
		fs.writeFileSync(
			crashPath,
			`${JSON.stringify(records.map((record) => (record && typeof record === "object" && !record.notified ? { ...record, notified: true } : record)), null, 2)}\n`,
		);
		const history = [...readJsonArray(archivePath), ...pending].slice(-MAX_ARCHIVE_RECORDS);
		fs.writeFileSync(archivePath, `${JSON.stringify(history, null, 2)}\n`);
	} catch (error) {
		return { archived: 0, error: error instanceof Error ? error.message : String(error) };
	}
	return { archived: pending.length };
}
