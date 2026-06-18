import type { RecallEvaluationExpected, RecallEvaluationFixture } from "./recall-eval-fixtures.js";

export interface RecallEvaluationRunner {
  recall(fixture: RecallEvaluationFixture): Promise<RecallEvaluationExpected> | RecallEvaluationExpected;
}

export interface RecallEvaluationResult {
  fixtureId: string;
  passed: boolean;
  errors: string[];
}

export interface RecallEvaluationRun {
  passed: number;
  failed: number;
  results: RecallEvaluationResult[];
}

export async function runRecallEvaluationFixtures(
  fixtures: RecallEvaluationFixture[],
  runner: RecallEvaluationRunner
): Promise<RecallEvaluationRun> {
  const results: RecallEvaluationResult[] = [];
  for (const fixture of fixtures) {
    const actual = await runner.recall(fixture);
    const errors = evaluateFixture(fixture, actual);
    results.push({ fixtureId: fixture.id, passed: errors.length === 0, errors });
  }
  return {
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    results
  };
}

function evaluateFixture(fixture: RecallEvaluationFixture, actual: RecallEvaluationExpected): string[] {
  const errors: string[] = [];
  if (actual.shouldUseMemory !== fixture.expected.shouldUseMemory) {
    errors.push(
      `shouldUseMemory expected ${String(fixture.expected.shouldUseMemory)} but got ${String(actual.shouldUseMemory)}`
    );
  }

  for (const id of fixture.expected.selectedMemoryIds) {
    if (!actual.selectedMemoryIds.includes(id)) {
      errors.push(`missing memory ${id}`);
    }
  }
  for (const id of actual.selectedMemoryIds) {
    if (!fixture.expected.selectedMemoryIds.includes(id)) {
      errors.push(`unexpected memory ${id}`);
    }
    const memory = fixture.memories.find((item) => item.id === id);
    if (memory?.status !== "active") {
      errors.push(`selected inactive memory ${id}`);
    }
  }

  for (const snippet of fixture.expected.promptSnippets) {
    if (!actual.promptSnippets.includes(snippet)) {
      errors.push(`missing prompt snippet ${snippet}`);
    }
  }
  return errors;
}
