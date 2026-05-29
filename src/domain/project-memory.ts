import { z } from "zod";
import type { LlmCompletionClient } from "./extractors.js";
import { RuleBasedMemoryResolver, type MemoryResolver } from "./resolver.js";
import type { CreateMemoryInput, Memory, Scope } from "./types.js";
import type { MemoryStore } from "../storage/store.js";

export interface ProjectExtractionInput {
  topics: Memory[];
  existingProjects: Memory[];
  scope: Scope;
}

export interface ProjectMemoryExtractor {
  extract(input: ProjectExtractionInput): Promise<CreateMemoryInput[]> | CreateMemoryInput[];
}

export function rebuildProjectMemories(
  repo: MemoryStore,
  scope: Scope,
  extractor: ProjectMemoryExtractor = new NoopProjectMemoryExtractor()
): Promise<Memory[]> {
  return new ModelProjectMemoryBuilder(extractor).rebuild(repo, scope);
}

export interface ProjectMemoryBuilder {
  rebuild(repo: MemoryStore, scope: Scope): Promise<Memory[]> | Memory[];
}

export class ModelProjectMemoryBuilder implements ProjectMemoryBuilder {
  constructor(
    private readonly extractor: ProjectMemoryExtractor = new NoopProjectMemoryExtractor(),
    private readonly resolver: MemoryResolver = new RuleBasedMemoryResolver()
  ) {}

  async rebuild(repo: MemoryStore, scope: Scope): Promise<Memory[]> {
    const topics = repo
      .listMemories(scope)
      .filter((memory) => memory.level === "topic" && memory.type === "topic" && memory.status === "active");
    const existingProjects = repo
      .listMemories(scope)
      .filter((memory) => memory.level === "L2" && memory.type === "project" && memory.status === "active");

    const drafts = await this.extractor.extract({ topics, existingProjects, scope });
    return drafts.map((draft) => this.resolver.resolve(repo, draft));
  }
}

export class NoopProjectMemoryExtractor implements ProjectMemoryExtractor {
  extract(): CreateMemoryInput[] {
    return [];
  }
}

const llmProjectSchema = z.object({
  projectKey: z.string().min(1),
  projectName: z.string().min(1),
  projectType: z.enum(["repository", "product", "system", "feature", "workflow", "research", "personal_context"]),
  purpose: z.string().min(1),
  currentState: z.string().min(1),
  decisions: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  evidenceMemoryIds: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1)
});

const llmProjectResponseSchema = z.object({
  projects: z.array(llmProjectSchema)
});

export class LlmProjectMemoryExtractor implements ProjectMemoryExtractor {
  constructor(private readonly client: LlmCompletionClient) {}

  async extract(input: ProjectExtractionInput): Promise<CreateMemoryInput[]> {
    const raw = await this.client.complete(buildPrompt(input));
    const parsed = parseProjectResponse(raw);
    return parsed.projects.map((project) => {
      const evidenceTopics = input.topics.filter((topic) => project.evidenceMemoryIds.includes(topic.id));
      return {
        level: "L2",
        type: "project",
        subject: project.projectName,
        predicate: "project",
        object: project.currentState,
        summary: buildProjectSummary(project),
        confidence: project.confidence,
        status: "active",
        supersedesId: null,
        sourceTurnIds: Array.from(new Set(evidenceTopics.flatMap((topic) => topic.sourceTurnIds))),
        mis: input.scope.mis,
        source: input.scope.source,
        agent: input.scope.agent,
        channel: input.scope.channel,
        metadata: {
          ...input.scope.metadata,
          projectKey: project.projectKey,
          projectType: project.projectType,
          purpose: project.purpose,
          decisions: project.decisions,
          constraints: project.constraints,
          openQuestions: project.openQuestions,
          evidenceMemoryIds: project.evidenceMemoryIds
        }
      };
    });
  }
}

function parseProjectResponse(raw: string): z.infer<typeof llmProjectResponseSchema> {
  try {
    return llmProjectResponseSchema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`Invalid LLM project extraction response: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

function buildPrompt(input: ProjectExtractionInput): string {
  return JSON.stringify({
    task: "Extract stable L2 project memories from L1 topic memories. Return strict JSON.",
    dimensions: ["workspace", "system", "goal", "module", "workflow", "constraint", "stakeholder/context"],
    topics: input.topics,
    existingProjects: input.existingProjects
  });
}

function buildProjectSummary(project: z.infer<typeof llmProjectSchema>): string {
  return [
    project.purpose,
    project.currentState,
    project.decisions.length > 0 ? `Decisions: ${project.decisions.join("; ")}` : "",
    project.constraints.length > 0 ? `Constraints: ${project.constraints.join("; ")}` : "",
    project.openQuestions.length > 0 ? `Open questions: ${project.openQuestions.join("; ")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}
