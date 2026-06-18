import type { TopicWindowConfig } from "../domain/topics.js";

export function loadTopicWindowConfig(env: Record<string, string | undefined> = process.env): Partial<TopicWindowConfig> {
  return {
    ...numberConfig("TOPIC_BUFFER_MAX_TURNS", env.TOPIC_BUFFER_MAX_TURNS, "maxSize", { integer: true, min: 1 }),
    ...numberConfig("TOPIC_BOUNDARY_CONFIDENCE", env.TOPIC_BOUNDARY_CONFIDENCE, "minConfidence", { min: 0, max: 1 }),
    ...booleanConfig("TOPIC_BOUNDARY_EXCLUDE_LAST_TURN", env.TOPIC_BOUNDARY_EXCLUDE_LAST_TURN, "excludeLastTurnForBoundary"),
    ...numberConfig("TOPIC_BOUNDARY_EXCLUDE_THRESHOLD", env.TOPIC_BOUNDARY_EXCLUDE_THRESHOLD, "excludeLastTurnThreshold", {
      integer: true,
      min: 0
    })
  };
}

function numberConfig<K extends keyof TopicWindowConfig>(
  name: string,
  raw: string | undefined,
  key: K,
  options: { integer?: boolean; min?: number; max?: number }
): Partial<TopicWindowConfig> {
  if (raw === undefined || raw === "") {
    return {};
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || (options.integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a valid ${options.integer ? "integer" : "number"}`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new Error(`${name} must be >= ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${name} must be <= ${options.max}`);
  }
  return { [key]: value } as Partial<TopicWindowConfig>;
}

function booleanConfig<K extends keyof TopicWindowConfig>(
  name: string,
  raw: string | undefined,
  key: K
): Partial<TopicWindowConfig> {
  if (raw === undefined || raw === "") {
    return {};
  }
  if (raw === "true") {
    return { [key]: true } as Partial<TopicWindowConfig>;
  }
  if (raw === "false") {
    return { [key]: false } as Partial<TopicWindowConfig>;
  }
  throw new Error(`${name} must be true or false`);
}
