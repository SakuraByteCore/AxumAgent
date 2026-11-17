const MINUTE = 60_000;
export const LOOP_TTL = 7 * 24 * 60 * MINUTE;
export const FIVE_MINUTE_CADENCE = 285_000;
const MAX_SEARCH_YEARS = 8;
const LIMITS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

type CronField = { values: Set<number>; wildcard: boolean };
export type Cron = CronField[];

export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== LIMITS.length) throw new Error("cron 必须包含五个字段。");
  return parts.map((part, index) => {
    const [min, max] = LIMITS[index];
    const values = new Set<number>();
    for (const item of part.split(",")) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
      if (!match) throw new Error(`不支持 cron 字段：${part}`);
      const step = Number(match[2] ?? 1);
      const range = match[1] === "*" ? [min, max] : match[1].split("-").map(Number);
      const start = range[0];
      const end = range[1] ?? (match[2] ? max : start);
      if (!Number.isSafeInteger(step) || step < 1 || step > max - min + 1 || start < min || end > max || start > end) {
        throw new Error(`cron 字段超出范围：${part}`);
      }
      for (let value = start; value <= end; value += step) values.add(index === 4 && value === 7 ? 0 : value);
    }
    // Vixie-cron treats a field beginning with '*' as unrestricted for DOM/DOW.
    return { values, wildcard: part.startsWith("*") };
  });
}

function matchesDay(date: Date, cron: Cron): boolean {
  const dom = cron[2].values.has(date.getDate());
  const dow = cron[4].values.has(date.getDay());
  return cron[2].wildcard || cron[4].wildcard ? dom && dow : dom || dow;
}

export function nextCronTime(expression: string, after: number): number {
  const cron = parseCron(expression);
  const date = new Date(Math.floor(after / MINUTE) * MINUTE + MINUTE);
  const limit = new Date(after);
  limit.setFullYear(limit.getFullYear() + MAX_SEARCH_YEARS);
  while (date <= limit) {
    if (!cron[3].values.has(date.getMonth() + 1) || !matchesDay(date, cron)) {
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
    } else if (!cron[1].values.has(date.getHours())) {
      date.setTime(date.getTime() + (60 - date.getMinutes()) * MINUTE);
    } else if (!cron[0].values.has(date.getMinutes())) {
      date.setTime(date.getTime() + MINUTE);
    } else {
      return date.getTime();
    }
  }
  throw new Error("cron 在未来八年内没有执行时间。");
}

export function cronFireTime(options: { schedule: string; after: number; recurring: boolean; jitter: number }): number {
  const { schedule, after, recurring, jitter } = options;
  if (recurring && schedule.trim().replace(/\s+/g, " ") === "*/5 * * * *") {
    return after + FIVE_MINUTE_CADENCE;
  }
  const nominal = nextCronTime(schedule, after);
  if (!recurring) {
    const minute = new Date(nominal).getMinutes();
    return Math.max(after + 1, nominal - (minute === 0 || minute === 30 ? jitter * 90_000 : 0));
  }
  const gap = nextCronTime(schedule, nominal) - nominal;
  return nominal + Math.floor(jitter * Math.min(gap / 2, 30 * MINUTE));
}

export type LoopArguments = { prompt: string; schedule?: string; requestedMinutes?: number; actualMinutes?: number };
const UNIT_MINUTES: Record<string, number> = { s: 1 / 60, m: 1, h: 60, d: 1440 };
const INTERVALS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440];

export function parseLoopArguments(args: string): LoopArguments {
  const text = args.trim();
  const leading = /^(\d+(?:\.\d+)?)\s*([smhd])(?:\s+|$)/i.exec(text);
  const trailing = /\s+every\s+(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?|days?|[smhd])$/i.exec(text);
  const match = leading ?? trailing;
  if (!match) {
    if (/^-?\d+(?:\.\d+)?\s*[a-z]+(?:\s|$)/i.test(text)) throw new Error("间隔必须为正数，单位使用 s、m、h、d。");
    return { prompt: text };
  }
  const requestedMinutes = Math.ceil(Number(match[1]) * UNIT_MINUTES[match[2][0].toLowerCase()]);
  if (!Number.isSafeInteger(requestedMinutes) || requestedMinutes < 1) throw new Error("间隔必须大于零。");
  const actualMinutes = INTERVALS.reduce((best, value) => Math.abs(value - requestedMinutes) <= Math.abs(best - requestedMinutes) ? value : best);
  const schedule = actualMinutes < 60 ? `*/${actualMinutes} * * * *`
    : actualMinutes < 1440 ? `0 */${actualMinutes / 60} * * *` : "0 0 * * *";
  const prompt = leading ? text.slice(match[0].length).trim() : text.slice(0, match.index).trim();
  return { prompt, schedule, requestedMinutes, actualMinutes };
}
