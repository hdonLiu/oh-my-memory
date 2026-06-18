import type { ProjectEvaluationFixture } from "./project-eval-fixtures.js";

export interface ProjectEvaluationOutput {
  projectKey: string;
  projectName: string;
  projectType: "repository" | "product" | "system" | "feature" | "workflow" | "research" | "personal_context";
  evidenceTopicIds: string[];
}

export interface ProjectEvaluationExtractor {
  extract(fixture: ProjectEvaluationFixture): Promise<ProjectEvaluationOutput[]> | ProjectEvaluationOutput[];
}

export interface ProjectEvaluationResult {
  fixtureId: string;
  passed: boolean;
  errors: string[];
}

export interface ProjectEvaluationRun {
  passed: number;
  failed: number;
  results: ProjectEvaluationResult[];
}

export async function runProjectEvaluationFixtures(
  fixtures: ProjectEvaluationFixture[],
  extractor: ProjectEvaluationExtractor
): Promise<ProjectEvaluationRun> {
  const results: ProjectEvaluationResult[] = [];
  for (const fixture of fixtures) {
    const actual = await extractor.extract(fixture);
    const errors = evaluateFixture(fixture, actual);
    results.push({ fixtureId: fixture.id, passed: errors.length === 0, errors });
  }
  return {
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    results
  };
}

function evaluateFixture(fixture: ProjectEvaluationFixture, actual: ProjectEvaluationOutput[]): string[] {
  const errors: string[] = [];
  const actualByKey = new Map(actual.map((project) => [project.projectKey, project]));

  for (const expected of fixture.expected.projects) {
    const project = actualByKey.get(expected.projectKey);
    if (!project) {
      errors.push(`missing project ${expected.projectKey}`);
      continue;
    }
    if (project.projectName !== expected.projectName) {
      errors.push(`project ${expected.projectKey} name expected ${expected.projectName} but got ${project.projectName}`);
    }
    if (project.projectType !== expected.projectType) {
      errors.push(`project ${expected.projectKey} type expected ${expected.projectType} but got ${project.projectType}`);
    }
    const missingEvidence = expected.evidenceTopicIds.filter((id) => !project.evidenceTopicIds.includes(id));
    if (missingEvidence.length > 0) {
      errors.push(`project ${expected.projectKey} missing evidence topics ${missingEvidence.join(", ")}`);
    }
  }

  for (const project of actual) {
    const expected = fixture.expected.projects.find((item) => item.projectKey === project.projectKey);
    if (!expected) {
      errors.push(`unexpected project ${project.projectKey}`);
      continue;
    }
    const excludedUsed = project.evidenceTopicIds.filter((id) => fixture.expected.excludedTopicIds.includes(id));
    if (excludedUsed.length > 0) {
      errors.push(`project ${project.projectKey} used excluded topics ${excludedUsed.join(", ")}`);
    }
  }

  return errors;
}
