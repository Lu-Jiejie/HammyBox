/**
 * 上传趋势统计（从 indexManager 拆分出的纯函数模块）
 *
 * 本模块仅包含上传趋势/渠道统计的纯函数，无数据库依赖。
 */

import type { FileMetadata } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TREND_MAX_POINTS = 90;
const MAX_TREND_POINTS = 366;
const DEFAULT_TREND_SERIES_LIMIT = 8;
const MAX_TREND_SERIES_LIMIT = 20;

/** 趋势统计选项 */
export interface TrendOptions {
  timezoneOffset?: number | string;
  maxPoints?: number | string;
  seriesLimit?: number | string;
  startDate?: string;
  endDate?: string;
}

/** 趋势分组条目 */
interface TrendGroupEntry {
  total: number;
  buckets: Map<number, number>;
}

/** 上传趋势累加器 */
export interface UploadTrendAccumulator {
  enabled: boolean;
  timezoneOffset: number;
  maxPoints: number;
  seriesLimit: number;
  startDay?: number;
  endDay?: number;
  bucketSizeDays?: number;
  bucketCount?: number;
  labels?: string[];
  total?: number[];
  channelGroups: Map<string, TrendGroupEntry>;
  channelNameGroups: Map<string, TrendGroupEntry>;
}

/** 趋势序列结果 */
export interface TrendSeriesResult {
  series: Array<{
    name: string;
    total: number;
    data: number[];
    isOther?: boolean;
  }>;
  totalSeries: number;
  limited: boolean;
}

/** 上传趋势最终结果 */
export interface UploadTrendResult {
  labels: string[];
  total: number[];
  bucketSizeDays: number;
  maxPoints: number;
  seriesLimit: number;
  range: {
    startDate: string;
    endDate: string;
    timezoneOffset: number;
  } | null;
  groupBy: {
    channel: TrendSeriesResult;
    channelName: TrendSeriesResult;
  };
}

export function incrementStat(stats: Record<string, number>, key: unknown): void {
  const normalizedKey = normalizeTrendKey(key);
  stats[normalizedKey] = (stats[normalizedKey] || 0) + 1;
}

export function normalizeChannel(channel: unknown): string {
  // 合并 TelegramNew 和旧版 Telegram
  if (channel === 'TelegramNew' || channel === 'Telegram') {
    return 'Telegram';
  }
  return normalizeTrendKey(channel, 'Telegraph');
}

function normalizeTrendKey(value: unknown, fallback: unknown = 'Unknown'): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return (trimmed || fallback) as string;
  }
  if (value === null || value === undefined) {
    return fallback as string;
  }
  return String(value);
}

function normalizeInteger(value: unknown, defaultValue: number, min: number, max: number): number {
  const parsed = Number.parseInt(value as string, 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.min(max, Math.max(min, parsed));
}

function getLocalDayNumber(timestamp: number, timezoneOffset: number): number {
  return Math.floor((timestamp - timezoneOffset * 60 * 1000) / DAY_MS);
}

function getValidTimestamp(metadata: FileMetadata): number | null {
  const timestamp = Number(metadata?.TimeStamp);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function formatTrendDay(dayNumber: number): string {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

function parseTrendDate(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return Math.floor(date.getTime() / DAY_MS);
}

function getTrendDayRange(
  files: Array<{ metadata: FileMetadata }>,
  timezoneOffset: number,
  options: TrendOptions = {},
): { startDay: number; endDay: number } | null {
  let newestDay: number | null = null;
  let oldestDay: number | null = null;
  const optionStartDay = parseTrendDate(options.startDate);
  const optionEndDay = parseTrendDate(options.endDate);

  // The index is maintained in timestamp-desc order, so this avoids sorting.
  for (let i = 0; i < files.length; i++) {
    const timestamp = getValidTimestamp(files[i].metadata);
    if (timestamp !== null) {
      newestDay = getLocalDayNumber(timestamp, timezoneOffset);
      break;
    }
  }

  for (let i = files.length - 1; i >= 0; i--) {
    const timestamp = getValidTimestamp(files[i].metadata);
    if (timestamp !== null) {
      oldestDay = getLocalDayNumber(timestamp, timezoneOffset);
      break;
    }
  }

  if (optionStartDay !== null || optionEndDay !== null) {
    const startDay = optionStartDay !== null ? optionStartDay : oldestDay !== null ? oldestDay : optionEndDay!;
    const endDay = optionEndDay !== null ? optionEndDay : newestDay !== null ? newestDay : optionStartDay!;
    return startDay <= endDay
      ? { startDay, endDay }
      : { startDay: endDay, endDay: startDay };
  }

  if (newestDay === null || oldestDay === null) {
    return null;
  }

  if (oldestDay > newestDay) {
    return { startDay: newestDay, endDay: oldestDay };
  }

  return { startDay: oldestDay, endDay: newestDay };
}

function buildTrendBucketLabels(
  startDay: number,
  endDay: number,
  bucketSizeDays: number,
  bucketCount: number,
): string[] {
  const labels = [];
  for (let i = 0; i < bucketCount; i++) {
    const bucketStartDay = startDay + i * bucketSizeDays;
    const bucketEndDay = Math.min(bucketStartDay + bucketSizeDays - 1, endDay);
    labels.push(
      bucketStartDay === bucketEndDay
        ? formatTrendDay(bucketStartDay)
        : `${formatTrendDay(bucketStartDay)} - ${formatTrendDay(bucketEndDay)}`
    );
  }
  return labels;
}

/**
 * 创建上传趋势累加器
 */
export function createUploadTrendAccumulator(
  files: Array<{ metadata: FileMetadata }>,
  options: TrendOptions = {},
): UploadTrendAccumulator {
  const timezoneOffset = normalizeInteger(options.timezoneOffset, 0, -14 * 60, 14 * 60);
  const maxPoints = normalizeInteger(options.maxPoints, DEFAULT_TREND_MAX_POINTS, 7, MAX_TREND_POINTS);
  const seriesLimit = normalizeInteger(options.seriesLimit, DEFAULT_TREND_SERIES_LIMIT, 1, MAX_TREND_SERIES_LIMIT);
  const range = getTrendDayRange(files, timezoneOffset, options);

  if (!range) {
    return {
      enabled: false,
      timezoneOffset,
      maxPoints,
      seriesLimit,
      channelGroups: new Map(),
      channelNameGroups: new Map(),
    };
  }

  const spanDays = range.endDay - range.startDay + 1;
  const bucketSizeDays = Math.max(1, Math.ceil(spanDays / maxPoints));
  const bucketCount = Math.ceil(spanDays / bucketSizeDays);

  return {
    enabled: true,
    timezoneOffset,
    maxPoints,
    seriesLimit,
    startDay: range.startDay,
    endDay: range.endDay,
    bucketSizeDays,
    bucketCount,
    labels: buildTrendBucketLabels(range.startDay, range.endDay, bucketSizeDays, bucketCount),
    total: Array(bucketCount).fill(0),
    channelGroups: new Map(),
    channelNameGroups: new Map(),
  };
}

/**
 * 添加上传趋势数据点
 */
export function addUploadTrendPoint(
  accumulator: UploadTrendAccumulator,
  metadata: FileMetadata,
  channel: unknown,
): void {
  if (!accumulator.enabled) {
    return;
  }

  const timestamp = getValidTimestamp(metadata);
  if (timestamp === null) {
    return;
  }

  const dayNumber = getLocalDayNumber(timestamp, accumulator.timezoneOffset);
  const bucketIndex = Math.floor(
    (dayNumber - (accumulator.startDay as number)) / (accumulator.bucketSizeDays as number)
  );
  if (bucketIndex < 0 || bucketIndex >= (accumulator.bucketCount as number)) {
    return;
  }

  const channelName = normalizeTrendKey(metadata.ChannelName, channel);

  (accumulator.total as number[])[bucketIndex] += 1;
  addTrendGroupPoint(accumulator.channelGroups, channel, bucketIndex);
  addTrendGroupPoint(accumulator.channelNameGroups, channelName, bucketIndex);
}

function addTrendGroupPoint(groups: Map<string, TrendGroupEntry>, key: unknown, bucketIndex: number): void {
  const normalizedKey = normalizeTrendKey(key);
  let entry = groups.get(normalizedKey);
  if (!entry) {
    entry = {
      total: 0,
      buckets: new Map(),
    };
    groups.set(normalizedKey, entry);
  }

  entry.total += 1;
  entry.buckets.set(bucketIndex, (entry.buckets.get(bucketIndex) || 0) + 1);
}

function buildTrendSeries(groups: Map<string, TrendGroupEntry>, bucketCount: number, seriesLimit: number): TrendSeriesResult {
  const selectedEntries = selectTopTrendEntries(groups, seriesLimit);
  const selectedNames = new Set(selectedEntries.map(([name]) => name));
  const series: TrendSeriesResult['series'] = selectedEntries.map(([name, entry]) => ({
    name,
    total: entry.total,
    data: buildTrendSeriesData(entry, bucketCount),
  }));

  if (groups.size > selectedEntries.length) {
    const otherData = Array(bucketCount).fill(0);
    let otherTotal = 0;

    for (const [name, entry] of groups.entries()) {
      if (selectedNames.has(name)) {
        continue;
      }
      otherTotal += entry.total;
      entry.buckets.forEach((count, bucketIndex) => {
        otherData[bucketIndex] += count;
      });
    }

    series.push({
      name: '__other__',
      isOther: true,
      total: otherTotal,
      data: otherData,
    });
  }

  return {
    series,
    totalSeries: groups.size,
    limited: groups.size > selectedEntries.length,
  };
}

function selectTopTrendEntries(groups: Map<string, TrendGroupEntry>, seriesLimit: number): Array<[string, TrendGroupEntry]> {
  const topEntries: Array<[string, TrendGroupEntry]> = [];

  for (const entry of groups.entries()) {
    insertTopTrendEntry(topEntries, entry, seriesLimit);
  }

  return topEntries;
}

function insertTopTrendEntry(
  topEntries: Array<[string, TrendGroupEntry]>,
  candidate: [string, TrendGroupEntry],
  seriesLimit: number,
): void {
  let insertIndex = -1;

  for (let i = 0; i < topEntries.length; i++) {
    if (compareTrendEntry(candidate, topEntries[i]) < 0) {
      insertIndex = i;
      break;
    }
  }

  if (insertIndex === -1) {
    if (topEntries.length < seriesLimit) {
      topEntries.push(candidate);
    }
    return;
  }

  topEntries.splice(insertIndex, 0, candidate);
  if (topEntries.length > seriesLimit) {
    topEntries.pop();
  }
}

function compareTrendEntry(
  left: [string, TrendGroupEntry],
  right: [string, TrendGroupEntry],
): number {
  if (right[1].total !== left[1].total) {
    return right[1].total - left[1].total;
  }
  return left[0].localeCompare(right[0]);
}

function buildTrendSeriesData(entry: TrendGroupEntry, bucketCount: number): number[] {
  const data = Array(bucketCount).fill(0);
  entry.buckets.forEach((count, bucketIndex) => {
    data[bucketIndex] = count;
  });
  return data;
}

/**
 * 最终化上传趋势结果
 */
export function finalizeUploadTrend(accumulator: UploadTrendAccumulator): UploadTrendResult {
  const emptyGroup: TrendSeriesResult = {
    series: [],
    totalSeries: 0,
    limited: false,
  };

  if (!accumulator.enabled) {
    return {
      labels: [],
      total: [],
      bucketSizeDays: 1,
      maxPoints: accumulator.maxPoints,
      seriesLimit: accumulator.seriesLimit,
      range: null,
      groupBy: {
        channel: emptyGroup,
        channelName: emptyGroup,
      },
    };
  }

  return {
    labels: accumulator.labels as string[],
    total: accumulator.total as number[],
    bucketSizeDays: accumulator.bucketSizeDays as number,
    maxPoints: accumulator.maxPoints,
    seriesLimit: accumulator.seriesLimit,
    range: {
      startDate: formatTrendDay(accumulator.startDay as number),
      endDate: formatTrendDay(accumulator.endDay as number),
      timezoneOffset: accumulator.timezoneOffset,
    },
    groupBy: {
      channel: buildTrendSeries(accumulator.channelGroups, accumulator.bucketCount as number, accumulator.seriesLimit),
      channelName: buildTrendSeries(accumulator.channelNameGroups, accumulator.bucketCount as number, accumulator.seriesLimit),
    },
  };
}