import type { ProjectTopicInput } from "./project-memory.js";

export interface ProjectEvaluationFixture {
  id: string;
  description: string;
  topics: ProjectTopicInput[];
  expected: {
    projects: Array<{
      projectKey: string;
      projectName: string;
      projectType: "repository" | "product" | "system" | "feature" | "workflow" | "research" | "personal_context";
      evidenceTopicIds: string[];
    }>;
    excludedTopicIds: string[];
  };
}

export const projectEvaluationFixtures: ProjectEvaluationFixture[] = [
  {
    id: "merge-topics-into-project",
    description: "Multiple project_work topics about the same repository should become one L2 project.",
    topics: [
      projectTopic({
        id: "topic-project-1",
        summary: "oh-my-memory implemented the topic layer.",
        entities: ["oh-my-memory"],
        tasks: ["Implement topic layer"]
      }),
      projectTopic({
        id: "topic-project-2",
        summary: "oh-my-memory added SQLite-backed vector search.",
        entities: ["oh-my-memory"],
        decisions: ["Use SQLite as local persistence"]
      })
    ],
    expected: {
      projects: [
        {
          projectKey: "repository:oh-my-memory",
          projectName: "oh-my-memory",
          projectType: "repository",
          evidenceTopicIds: ["topic-project-1", "topic-project-2"]
        }
      ],
      excludedTopicIds: []
    }
  },
  {
    id: "keep-distinct-projects-separate",
    description: "Topics with different project entities should not be merged into one project.",
    topics: [
      projectTopic({ id: "topic-project-a", summary: "Project A moved to PostgreSQL.", entities: ["Project A"] }),
      projectTopic({ id: "topic-project-b", summary: "Project B uses Redis.", entities: ["Project B"] })
    ],
    expected: {
      projects: [
        {
          projectKey: "repository:Project A",
          projectName: "Project A",
          projectType: "repository",
          evidenceTopicIds: ["topic-project-a"]
        },
        {
          projectKey: "repository:Project B",
          projectName: "Project B",
          projectType: "repository",
          evidenceTopicIds: ["topic-project-b"]
        }
      ],
      excludedTopicIds: []
    }
  },
  {
    id: "keep-workflow-as-workflow",
    description: "Workflow topics should stay workflow projects instead of being forced into repositories.",
    topics: [
      {
        ...projectTopic({
          id: "topic-workflow-1",
          summary: "The user wants PR verification to run npm test and typecheck before merge.",
          entities: ["PR verification"],
          tasks: ["Run npm test", "Run typecheck"]
        }),
        topicType: "workflow"
      }
    ],
    expected: {
      projects: [
        {
          projectKey: "workflow:PR verification",
          projectName: "PR verification",
          projectType: "workflow",
          evidenceTopicIds: ["topic-workflow-1"]
        }
      ],
      excludedTopicIds: []
    }
  },
  {
    id: "exclude-preference-topic",
    description: "Preference topics should not become L2 project memories.",
    topics: [
      {
        ...projectTopic({
          id: "topic-preference-1",
          summary: "The user prefers concise Chinese responses.",
          entities: ["user"],
          preferences: ["concise Chinese responses"]
        }),
        topicType: "preference"
      }
    ],
    expected: {
      projects: [],
      excludedTopicIds: ["topic-preference-1"]
    }
  }
];

function projectTopic(input: {
  id: string;
  summary: string;
  entities: string[];
  decisions?: string[];
  tasks?: string[];
  preferences?: string[];
}): ProjectTopicInput {
  return {
    id: input.id,
    subject: input.entities[0] ?? input.id,
    summary: input.summary,
    topicType: "project_work",
    entities: input.entities,
    decisions: input.decisions ?? [],
    tasks: input.tasks ?? [],
    preferences: input.preferences ?? [],
    sourceTurnIds: [`turn-${input.id}`],
    confidence: 0.8
  };
}
