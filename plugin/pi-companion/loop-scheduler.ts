import { randomBytes } from "node:crypto";
import { cronFireTime, LOOP_TTL, parseCron } from "./loop-cron.ts";

export const MAX_LOOP_TASKS = 50;
const MINUTE = 60_000;
const FALLBACK_DELAY = 20 * MINUTE;
export const LOOP_ENTRY = "axum-loop-tasks-v1";

export interface LoopTask {
  id: string;
  prompt: string;
  useDefault: boolean;
  schedule?: string;
  recurring: boolean;
  dynamic: boolean;
  createdAt: number;
  nextRun: number;
  jitter: number;
  fallbackUsed: boolean;
}
export interface LoopSnapshot { version: 1; cwd: string; tasks: LoopTask[] }
export interface SchedulerOptions { now?: () => number; random?: () => number; id?: () => string }

export class LoopScheduler {
  private tasks = new Map<string, LoopTask>();
  private running?: LoopTask;
  private rescheduled = false;
  private cancelled = false;
  readonly now: () => number;
  private readonly random: () => number;
  private readonly makeId: () => string;

  constructor(options: SchedulerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.makeId = options.id ?? (() => randomBytes(4).toString("hex"));
  }

  list(): LoopTask[] { return [...this.tasks.values()].map(task => ({ ...task })); }
  get active(): LoopTask | undefined { return this.running && { ...this.running }; }
  get busy(): boolean { return this.running !== undefined; }

  create(options: { prompt: string; schedule?: string; recurring?: boolean; useDefault?: boolean }): LoopTask {
    if (this.tasks.size >= MAX_LOOP_TASKS) throw new Error("每个会话最多创建 50 个调度任务。");
    if (!options.prompt.trim() && !options.useDefault) throw new Error("任务提示词不能为空。");
    const createdAt = this.now();
    const jitter = this.random();
    const dynamic = options.schedule === undefined;
    if (options.schedule !== undefined) parseCron(options.schedule);
    const recurring = dynamic ? false : options.recurring !== false;
    const nextRun = options.schedule !== undefined ? cronFireTime({ schedule: options.schedule, after: createdAt, recurring, jitter }) : createdAt;
    let id = this.makeId();
    while (this.tasks.has(id)) id = this.makeId();
    const task: LoopTask = { id, prompt: options.prompt, useDefault: options.useDefault === true, schedule: options.schedule,
      recurring, dynamic, createdAt, nextRun: recurring ? Math.min(nextRun, createdAt + LOOP_TTL) : nextRun, jitter, fallbackUsed: false };
    this.tasks.set(id, task);
    return { ...task };
  }

  delete(id: string): boolean {
    // Removing an active task cancels future wakeups, never the current model turn.
    if (this.running?.id === id) this.cancelled = true;
    return this.tasks.delete(id);
  }

  clear(): void { this.tasks.clear(); this.running = undefined; this.rescheduled = false; this.cancelled = false; }

  due(): LoopTask | undefined {
    if (this.running) return undefined;
    return this.list().filter(task => task.nextRun <= this.now()).sort((a, b) => a.nextRun - b.nextRun)[0];
  }

  begin(id: string): LoopTask | undefined {
    const task = this.tasks.get(id);
    if (this.running || !task || task.nextRun > this.now()) return undefined;
    this.running = { ...task };
    this.rescheduled = false;
    this.cancelled = false;
    if (!task.dynamic) {
      if (!task.recurring || this.now() >= task.createdAt + LOOP_TTL) this.tasks.delete(id);
      else task.nextRun = Math.min(task.createdAt + LOOP_TTL, cronFireTime({ schedule: task.schedule!, after: this.now(), recurring: true, jitter: task.jitter }));
    } else {
      // Keep the same ID and creation time throughout the self-paced loop.
      task.nextRun = Number.MAX_SAFE_INTEGER;
    }
    return { ...this.running };
  }

  failed(id: string): void {
    const task = this.tasks.get(id) ?? this.running;
    if (!this.cancelled && task?.id === id) this.tasks.set(id, { ...task, nextRun: this.now() + MINUTE });
    this.running = undefined;
  }

  wakeup(options: { id?: string; delaySeconds?: number; reason?: string; stop?: boolean }): LoopTask | undefined {
    const task = options.id ? this.tasks.get(options.id) : this.running && this.tasks.get(this.running.id);
    if (!task?.dynamic) throw new Error("ScheduleWakeup 只能调度当前动态循环；其他循环须提供 id。");
    if (options.stop) { this.delete(task.id); this.rescheduled = true; return undefined; }
    const seconds = options.delaySeconds;
    if (seconds === undefined || !Number.isInteger(seconds) || seconds < 60 || seconds > 3600 || !options.reason?.trim()) {
      throw new Error("提供 delaySeconds（60 至 3600 的整数）及 reason，或 stop: true。");
    }
    if (this.now() >= task.createdAt + LOOP_TTL) {
      this.tasks.delete(task.id);
      this.rescheduled = true;
      return undefined;
    }
    const nominal = this.now() + seconds * 1000;
    const minute = new Date(nominal).getMinutes();
    task.nextRun = Math.min(task.createdAt + LOOP_TTL, Math.max(this.now() + MINUTE, nominal - (minute === 0 || minute === 30 ? task.jitter * 90_000 : 0)));
    task.fallbackUsed = false;
    if (this.running?.id === task.id) this.rescheduled = true;
    return { ...task };
  }

  settle(): void {
    const running = this.running;
    this.running = undefined;
    if (!running?.dynamic) return;
    const task = this.tasks.get(running.id);
    if (!task) return;
    if (this.now() >= task.createdAt + LOOP_TTL || (!this.rescheduled && task.fallbackUsed)) {
      this.tasks.delete(task.id);
    } else if (!this.rescheduled) {
      task.nextRun = Math.min(task.createdAt + LOOP_TTL, this.now() + FALLBACK_DELAY);
      task.fallbackUsed = true;
    }
  }

  cancelWaitingDynamic(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.dynamic && this.running?.id !== task.id) { this.tasks.delete(task.id); count++; }
    }
    return count;
  }

  snapshot(cwd: string): LoopSnapshot {
    return { version: 1, cwd, tasks: this.list().filter(task => !task.dynamic) };
  }

  restore(data: LoopSnapshot, cwd: string): void {
    this.clear();
    if (data.version !== 1 || data.cwd !== cwd) return;
    for (const task of data.tasks.slice(0, MAX_LOOP_TASKS)) {
      if (task.dynamic || !task.schedule || (task.recurring ? task.createdAt + LOOP_TTL <= this.now() : task.nextRun <= this.now())) continue;
      parseCron(task.schedule);
      const nextRun = task.recurring ? cronFireTime({ schedule: task.schedule, after: this.now(), recurring: true, jitter: task.jitter }) : task.nextRun;
      this.tasks.set(task.id, { ...task, nextRun: task.recurring ? Math.min(nextRun, task.createdAt + LOOP_TTL) : nextRun });
    }
  }
}

// Session custom entries are external data; validate before restoring executable prompts.
export function isLoopSnapshot(data: unknown): data is LoopSnapshot {
  if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1 || !("cwd" in data) || typeof data.cwd !== "string" || !("tasks" in data) || !Array.isArray(data.tasks)) return false;
  return data.tasks.every((task: unknown) => {
    if (!task || typeof task !== "object") return false;
    return "id" in task && typeof task.id === "string" && /^[a-f0-9]{8}$/.test(task.id)
      && "prompt" in task && typeof task.prompt === "string"
      && "schedule" in task && typeof task.schedule === "string"
      && "useDefault" in task && typeof task.useDefault === "boolean"
      && "recurring" in task && typeof task.recurring === "boolean"
      && "dynamic" in task && task.dynamic === false
      && "createdAt" in task && typeof task.createdAt === "number" && Number.isSafeInteger(task.createdAt)
      && "nextRun" in task && typeof task.nextRun === "number" && Number.isFinite(task.nextRun)
      && "jitter" in task && typeof task.jitter === "number" && task.jitter >= 0 && task.jitter <= 1
      && "fallbackUsed" in task && typeof task.fallbackUsed === "boolean";
  });
}
