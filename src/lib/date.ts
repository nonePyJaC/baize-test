export function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number" || (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return new Date(numeric < 100_000_000_000 ? numeric * 1000 : numeric);
  }

  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatDate(value: unknown, fallback = "未设置"): string {
  const date = toDate(value);
  if (!date) return fallback;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDateTime(value: unknown, fallback = "未设置"): string {
  const date = toDate(value);
  if (!date) return fallback;
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatActivityTime(value: unknown, fallback = "未设置"): string {
  const date = toDate(value);
  if (!date) return fallback;
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay) return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return formatDateTime(date, fallback);
}

export function toIsoNow(): string {
  return new Date().toISOString();
}
