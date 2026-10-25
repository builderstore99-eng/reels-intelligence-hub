import { getModel } from './providers.js';

/**
 * Cost estimation.
 *
 * Deliberately simple and clearly labelled as an estimate in the UI. Real
 * billing depends on provider-side rounding, cached tokens, and batch
 * discounts that we do not model.
 */

export interface CostUnits {
  inputTokens?: number;
  outputTokens?: number;
  audioSeconds?: number;
  imageCount?: number;
}

export function estimateCostUsd(modelId: string, units: CostUnits): number {
  const model = getModel(modelId);
  if (!model) return 0;

  let cost = 0;

  if (units.inputTokens && model.inputCostPerMTokens) {
    cost += (units.inputTokens / 1_000_000) * model.inputCostPerMTokens;
  }
  if (units.outputTokens && model.outputCostPerMTokens) {
    cost += (units.outputTokens / 1_000_000) * model.outputCostPerMTokens;
  }
  if (units.audioSeconds && model.costPerAudioMinute) {
    cost += (units.audioSeconds / 60) * model.costPerAudioMinute;
  }

  // Round to 6dp — sub-cent precision, no floating point noise in the UI.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Rough token estimate for text, used when a provider does not report usage. */
export function estimateTokens(text: string): number {
  // ~4 characters per token is the standard English approximation.
  return Math.max(1, Math.ceil(text.length / 4));
}

export function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, index);
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
