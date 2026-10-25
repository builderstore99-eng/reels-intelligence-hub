import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return 'never';
  const date = new Date(value).getTime();
  if (Number.isNaN(date)) return 'never';
  const diff = Date.now() - date;
  const abs = Math.abs(diff);

  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [1000 * 60, 'minute'],
    [1000 * 60 * 60, 'hour'],
    [1000 * 60 * 60 * 24, 'day'],
    [1000 * 60 * 60 * 24 * 7, 'week'],
    [1000 * 60 * 60 * 24 * 30, 'month'],
    [1000 * 60 * 60 * 24 * 365, 'year'],
  ];

  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 60_000) return 'just now';

  let chosen: [number, Intl.RelativeTimeFormatUnit] = units[0]!;
  for (const unit of units) {
    if (abs >= unit[0]) chosen = unit;
  }
  const amount = Math.round(diff / chosen[0]);
  return formatter.format(-amount, chosen[1]);
}

export function truncate(value: string | null | undefined, length: number): string {
  if (!value) return '';
  return value.length > length ? `${value.slice(0, length).trimEnd()}…` : value;
}

export function pluralise(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

export function percent(value: number): string {
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}
