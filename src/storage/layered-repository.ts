import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import type {
  GenerationProvenance,
  L1Component,
  L1MaintenancePlan,
  L1MaintenancePlanItem,
  L1MaintenanceRun,
  L1Topic,
  L1TopicRevision,
  L2Aggregate,
  L2AggregateContent,
  L2AggregateRevision,
  L2AggregationRun,
  L2DesiredMembership,
  L2MembershipPlan,
  Scope,
  TopicSegment
} from "../domain/types.js";

export interface L1TopicView {
  topic: L1Topic;
  revision: L1TopicRevision;
  components: L1Component[];
}

export interface L2AggregateView {
  aggregate: L2Aggregate;
  revision: L2AggregateRevision;
  componentIds: string[];
}

export interface L2SynthesisOutput {
  membership: L2DesiredMembership;
  content: L2AggregateContent;
  provenance: GenerationProvenance;
}

export class LayeredMemoryRepository {
  constructor(private readonly db: Database.Database) {}

  appendProvisionalTopic(segment: TopicSegment, provenance: GenerationProvenance): L1TopicView {
    const existing = this.db
      .prepare("select topic_id from l1_topic_revisions where source_segment_id = ?")
      .get(segment.id) as { topic_id: string } | undefined;
    if (existing) {
      const view = this.getL1TopicView(existing.topic_id);
      if (!view) throw new Error(`L1 topic missing for source segment: ${segment.id}`);
      return view;
    }

    const createdAt = now();
    const topicId = nanoid();
    const revisionId = nanoid();
    this.db.transaction(() => {
      this.db
        .prepare(
          `insert into l1_topics
          (id, session_id, status, current_revision_id, uid, source, agent, channel, metadata, created_at, updated_at)
          values (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          topicId,
          segment.sessionId,
          revisionId,
          segment.uid,
          segment.source,
          segment.agent,
          segment.channel,
          JSON.stringify(segment.metadata),
          createdAt,
          createdAt
        );
      this.insertL1Revision({
        id: revisionId,
        topicId,
        version: 1,
        status: "provisional",
        title: segment.title,
        summary: segment.summary,
        sourceTurnIds: segment.turnIds,
        sourceSegmentId: segment.id,
        stableSequence: null,
        ...provenance,
        createdAt
      });
    })();
    return this.getL1TopicView(topicId)!;
  }

  listL1TopicViews(filter: Partial<Scope> & { sessionId?: string; includeInactive?: boolean } = {}): L1TopicView[] {
    const rows = this.db.prepare("select * from l1_topics order by created_at asc").all() as L1TopicRow[];
    return rows
      .map(mapL1Topic)
      .filter(
        (topic) =>
          (!filter.uid || topic.uid === filter.uid) &&
          (!filter.source || topic.source === filter.source) &&
          (!filter.agent || topic.agent === filter.agent) &&
          (!filter.channel || topic.channel === filter.channel) &&
          (!filter.sessionId || topic.sessionId === filter.sessionId) &&
          (filter.includeInactive || topic.status === "active")
      )
      .map((topic) => this.getL1TopicView(topic.id))
      .filter((view): view is L1TopicView => Boolean(view));
  }

  getL1TopicView(topicId: string): L1TopicView | null {
    const row = this.db.prepare("select * from l1_topics where id = ?").get(topicId) as L1TopicRow | undefined;
    if (!row) return null;
    const topic = mapL1Topic(row);
    const revision = this.getL1Revision(topic.currentRevisionId);
    if (!revision) return null;
    return { topic, revision, components: this.listL1Components(revision.id) };
  }

  getL1Revision(revisionId: string): L1TopicRevision | null {
    const row = this.db.prepare("select * from l1_topic_revisions where id = ?").get(revisionId) as
      | L1RevisionRow
      | undefined;
    return row ? mapL1Revision(row) : null;
  }

  listL1Components(topicRevisionId?: string): L1Component[] {
    const rows = topicRevisionId
      ? this.db.prepare("select * from l1_components where topic_revision_id = ? order by created_at asc").all(topicRevisionId)
      : this.db.prepare("select * from l1_components order by created_at asc").all();
    return (rows as L1ComponentRow[]).map(mapL1Component);
  }

  listStableComponents(uid: string, agent: string, watermark = this.getL1StableWatermark(uid, agent)): L1Component[] {
    return (this.db
      .prepare(
        `select c.* from l1_components c
         join l1_topic_revisions r on r.id = c.topic_revision_id
         join l1_topics t on t.id = r.topic_id
         where t.uid = ? and t.agent = ? and t.status = 'active'
           and r.status = 'canonical' and r.stable_sequence <= ?
         order by r.stable_sequence asc, c.created_at asc`
      )
      .all(uid, agent, watermark) as L1ComponentRow[]).map(mapL1Component);
  }

  getL1StableWatermark(uid: string, agent: string): number {
    const row = this.db
      .prepare("select coalesce(max(sequence), 0) as watermark from l1_stable_sequence where uid = ? and agent = ?")
      .get(uid, agent) as { watermark: number };
    return row.watermark;
  }

  runL1Maintenance(
    scope: Scope,
    sessionId: string,
    inputCutoff: string,
    plan: L1MaintenancePlan,
    provenance: Omit<GenerationProvenance, "reason" | "confidence">
  ): L1MaintenanceRun {
    const idempotencyKey = digest([scope.uid, scope.source, scope.agent, scope.channel, sessionId, inputCutoff, JSON.stringify(plan)]);
    const prior = this.db.prepare("select * from l1_maintenance_runs where idempotency_key = ?").get(idempotencyKey) as L1RunRow | undefined;
    if (prior?.status === "success") return mapL1Run(prior);
    const runId = prior?.id ?? nanoid();
    const startedAt = now();
    if (prior) {
      this.db
        .prepare("update l1_maintenance_runs set status = 'running', plan = ?, error = null, started_at = ?, ended_at = null where id = ?")
        .run(JSON.stringify(plan), startedAt, runId);
    } else {
      this.db
        .prepare(
          `insert into l1_maintenance_runs
          (id, idempotency_key, uid, source, agent, channel, session_id, input_cutoff, output_watermark, status, plan, error, started_at, ended_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, null, 'running', ?, null, ?, null)`
        )
        .run(runId, idempotencyKey, scope.uid, scope.source, scope.agent, scope.channel, sessionId, inputCutoff, JSON.stringify(plan), startedAt);
    }

    try {
      const outputWatermark = this.db.transaction(() => {
        let watermark = this.getL1StableWatermark(scope.uid, scope.agent);
        for (const item of plan.items) {
          watermark = Math.max(watermark, this.applyL1PlanItem(runId, scope, sessionId, item, provenance));
        }
        this.db
          .prepare("update l1_maintenance_runs set status = 'success', output_watermark = ?, ended_at = ? where id = ?")
          .run(watermark, now(), runId);
        return watermark;
      })();
      return this.getL1MaintenanceRun(runId, outputWatermark)!;
    } catch (error) {
      this.db
        .prepare("update l1_maintenance_runs set status = 'failed', error = ?, ended_at = ? where id = ?")
        .run(errorMessage(error), now(), runId);
      throw error;
    }
  }

  listL1MaintenanceRuns(limit = 20): L1MaintenanceRun[] {
    return (this.db.prepare("select * from l1_maintenance_runs order by started_at desc limit ?").all(limit) as L1RunRow[]).map(
      mapL1Run
    );
  }

  listL2AggregateViews(uid: string, agent: string, includeInactive = false): L2AggregateView[] {
    const rows = this.db
      .prepare("select * from l2_aggregates where uid = ? and agent = ? order by created_at asc")
      .all(uid, agent) as L2AggregateRow[];
    return rows
      .map(mapL2Aggregate)
      .filter((aggregate) => includeInactive || aggregate.status === "active")
      .map((aggregate) => this.getL2AggregateView(aggregate.id))
      .filter((view): view is L2AggregateView => Boolean(view));
  }

  getL2AggregateView(aggregateId: string): L2AggregateView | null {
    const row = this.db.prepare("select * from l2_aggregates where id = ?").get(aggregateId) as L2AggregateRow | undefined;
    if (!row) return null;
    const aggregate = mapL2Aggregate(row);
    const revisionRow = this.db.prepare("select * from l2_aggregate_revisions where id = ?").get(aggregate.currentRevisionId) as
      | L2RevisionRow
      | undefined;
    if (!revisionRow) return null;
    const memberships = this.db
      .prepare("select component_id from l2_component_memberships where aggregate_revision_id = ?")
      .all(aggregate.currentRevisionId) as Array<{ component_id: string }>;
    return { aggregate, revision: mapL2Revision(revisionRow), componentIds: memberships.map((row) => row.component_id) };
  }

  runL2Aggregation(
    uid: string,
    agent: string,
    watermark: number,
    plan: L2MembershipPlan,
    outputs: L2SynthesisOutput[]
  ): L2AggregationRun {
    const idempotencyKey = digest([uid, agent, String(watermark), JSON.stringify(plan)]);
    const prior = this.db.prepare("select * from l2_aggregation_runs where idempotency_key = ?").get(idempotencyKey) as L2RunRow | undefined;
    if (prior?.status === "success") return mapL2Run(prior);
    const runId = prior?.id ?? nanoid();
    const startedAt = now();
    if (prior) {
      this.db
        .prepare("update l2_aggregation_runs set status = 'running', plan = ?, error = null, started_at = ?, ended_at = null where id = ?")
        .run(JSON.stringify(plan), startedAt, runId);
    } else {
      this.db
        .prepare(
          `insert into l2_aggregation_runs
          (id, idempotency_key, uid, agent, source_l1_watermark, status, plan, error, started_at, ended_at)
          values (?, ?, ?, ?, ?, 'running', ?, null, ?, null)`
        )
        .run(runId, idempotencyKey, uid, agent, watermark, JSON.stringify(plan), startedAt);
    }
    try {
      this.db.transaction(() => {
        const allowed = new Set(this.listStableComponents(uid, agent, watermark).map((component) => component.id));
        for (const operation of plan.operations) {
          for (const componentId of operation.componentIds) {
            if (!allowed.has(componentId)) throw new Error(`L2 plan references unavailable Component: ${componentId}`);
          }
          if (operation.targetAggregateId) this.assertAggregateNamespace(operation.targetAggregateId, uid, agent);
          for (const aggregateId of operation.sourceAggregateIds ?? []) this.assertAggregateNamespace(aggregateId, uid, agent);
        }
        for (const id of plan.retireAggregateIds) {
          this.assertAggregateNamespace(id, uid, agent);
          this.db.prepare("update l2_aggregates set status = 'superseded', updated_at = ? where id = ?").run(now(), id);
        }
        for (const output of outputs) {
          this.applyL2Output(runId, uid, agent, watermark, output, allowed);
        }
        this.db.prepare("update l2_aggregation_runs set status = 'success', ended_at = ? where id = ?").run(now(), runId);
      })();
      return this.getL2AggregationRun(runId)!;
    } catch (error) {
      this.db
        .prepare("update l2_aggregation_runs set status = 'failed', error = ?, ended_at = ? where id = ?")
        .run(errorMessage(error), now(), runId);
      throw error;
    }
  }

  listL2AggregationRuns(limit = 20): L2AggregationRun[] {
    return (this.db.prepare("select * from l2_aggregation_runs order by started_at desc limit ?").all(limit) as L2RunRow[]).map(
      mapL2Run
    );
  }

  private applyL1PlanItem(
    runId: string,
    scope: Scope,
    sessionId: string,
    item: L1MaintenancePlanItem,
    provenance: Omit<GenerationProvenance, "reason" | "confidence">
  ): number {
    for (const topicId of item.sourceTopicIds) this.assertTopicScope(topicId, scope, sessionId);
    if (item.operation === "noop") return this.getL1StableWatermark(scope.uid, scope.agent);
    if (item.operation === "delete") {
      for (const topicId of item.sourceTopicIds) {
        this.db.prepare("update l1_topics set status = 'deleted', updated_at = ? where id = ?").run(now(), topicId);
        this.insertL1Lineage(runId, topicId, null, "delete", item.reason);
      }
      return this.getL1StableWatermark(scope.uid, scope.agent);
    }

    const sourceViews = item.sourceTopicIds
      .map((id) => this.getL1TopicView(id))
      .filter((view): view is L1TopicView => Boolean(view));
    const targetTopicId = item.targetTopicId ?? (item.operation === "keep" || item.operation === "revise" ? item.sourceTopicIds[0] : undefined) ?? nanoid();
    const existingTarget = this.getL1TopicView(targetTopicId);
    const sourceTurnIds = item.sourceTurnIds ?? unique(sourceViews.flatMap((view) => view.revision.sourceTurnIds));
    if (sourceTurnIds.length === 0) throw new Error(`L1 ${item.operation} requires sourceTurnIds`);
    this.assertTurnEvidence(scope, sessionId, sourceTurnIds);
    const title = item.title ?? existingTarget?.revision.title ?? sourceViews[0]?.revision.title;
    const summary = item.summary ?? existingTarget?.revision.summary ?? sourceViews[0]?.revision.summary;
    if (!title || !summary) throw new Error(`L1 ${item.operation} requires title and summary`);

    const createdAt = now();
    const revisionId = nanoid();
    if (!existingTarget) {
      this.db
        .prepare(
          `insert into l1_topics
          (id, session_id, status, current_revision_id, uid, source, agent, channel, metadata, created_at, updated_at)
          values (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(targetTopicId, sessionId, revisionId, scope.uid, scope.source, scope.agent, scope.channel, JSON.stringify(scope.metadata), createdAt, createdAt);
    } else {
      this.db.prepare("update l1_topic_revisions set status = 'superseded' where id = ?").run(existingTarget.revision.id);
    }
    const version = existingTarget ? existingTarget.revision.version + 1 : 1;
    this.insertL1Revision({
      id: revisionId,
      topicId: targetTopicId,
      version,
      status: "canonical",
      title,
      summary,
      sourceTurnIds,
      sourceSegmentId: null,
      stableSequence: null,
      ...provenance,
      reason: item.reason,
      confidence: item.confidence,
      createdAt
    });
    for (const component of item.components ?? []) {
      if (component.evidenceTurnIds.some((id) => !sourceTurnIds.includes(id))) {
        throw new Error("L1 component references evidence outside its Topic revision");
      }
      this.db
        .prepare(
          `insert into l1_components
          (id, topic_revision_id, content, labels, evidence_turn_ids, provider, model, prompt_version, schema_version,
           reason, confidence, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          nanoid(),
          revisionId,
          component.content,
          JSON.stringify(component.labels ?? []),
          JSON.stringify(component.evidenceTurnIds),
          provenance.provider ?? null,
          provenance.model ?? null,
          provenance.promptVersion,
          provenance.schemaVersion,
          item.reason,
          component.confidence ?? item.confidence,
          createdAt
        );
    }
    const sequenceResult = this.db
      .prepare("insert into l1_stable_sequence (topic_revision_id, run_id, uid, agent, created_at) values (?, ?, ?, ?, ?)")
      .run(revisionId, runId, scope.uid, scope.agent, createdAt);
    const stableSequence = Number(sequenceResult.lastInsertRowid);
    this.db.prepare("update l1_topic_revisions set stable_sequence = ? where id = ?").run(stableSequence, revisionId);
    this.db
      .prepare("update l1_topics set status = 'active', current_revision_id = ?, updated_at = ? where id = ?")
      .run(revisionId, createdAt, targetTopicId);

    for (const sourceTopicId of item.sourceTopicIds) {
      if (sourceTopicId !== targetTopicId) {
        const nextStatus = item.operation === "merge" ? "merged" : "superseded";
        this.db.prepare("update l1_topics set status = ?, updated_at = ? where id = ?").run(nextStatus, createdAt, sourceTopicId);
      }
      this.insertL1Lineage(runId, sourceTopicId, targetTopicId, item.operation, item.reason);
    }
    return stableSequence;
  }

  private applyL2Output(
    runId: string,
    uid: string,
    agent: string,
    watermark: number,
    output: L2SynthesisOutput,
    allowedComponents: Set<string>
  ): void {
    for (const componentId of output.membership.componentIds) {
      if (!allowedComponents.has(componentId)) throw new Error(`L2 plan references unavailable Component: ${componentId}`);
    }
    const membershipSet = new Set(output.membership.componentIds);
    for (const statement of [
      ...output.content.facts,
      ...output.content.decisions,
      ...output.content.constraints,
      ...output.content.openQuestions
    ]) {
      if (statement.evidenceComponentIds.some((id) => !membershipSet.has(id))) {
        throw new Error("L2 statement references evidence outside its validated Membership");
      }
    }

    const aggregateId = output.membership.aggregateId ?? nanoid();
    const existing = this.getL2AggregateView(aggregateId);
    if (existing) this.assertAggregateNamespace(aggregateId, uid, agent);
    const createdAt = now();
    const revisionId = nanoid();
    if (!existing) {
      this.db
        .prepare(
          `insert into l2_aggregates
          (id, uid, agent, status, current_revision_id, merged_into_id, created_at, updated_at)
          values (?, ?, ?, 'active', ?, null, ?, ?)`
        )
        .run(aggregateId, uid, agent, revisionId, createdAt, createdAt);
    }
    const version = existing ? existing.revision.version + 1 : 1;
    this.db
      .prepare(
        `insert into l2_aggregate_revisions
        (id, aggregate_id, version, aggregate_type, canonical_title, aliases, external_keys, labels, summary, facts, decisions, constraints,
         open_questions, source_l1_watermark, provider, model, prompt_version, schema_version, reason, confidence, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        revisionId,
        aggregateId,
        version,
        output.content.aggregateType,
        output.content.canonicalTitle,
        JSON.stringify(output.content.aliases),
        JSON.stringify(output.content.externalKeys),
        JSON.stringify(output.content.labels),
        output.content.summary,
        JSON.stringify(output.content.facts),
        JSON.stringify(output.content.decisions),
        JSON.stringify(output.content.constraints),
        JSON.stringify(output.content.openQuestions),
        watermark,
        output.provenance.provider ?? null,
        output.provenance.model ?? null,
        output.provenance.promptVersion,
        output.provenance.schemaVersion,
        output.provenance.reason,
        output.provenance.confidence,
        createdAt
      );
    for (const componentId of output.membership.componentIds) {
      this.db
        .prepare(
          `insert into l2_component_memberships
          (aggregate_revision_id, component_id, aggregation_run_id, created_at) values (?, ?, ?, ?)`
        )
        .run(revisionId, componentId, runId, createdAt);
    }
    this.db
      .prepare("update l2_aggregates set status = 'active', current_revision_id = ?, updated_at = ? where id = ?")
      .run(revisionId, createdAt, aggregateId);
    for (const sourceId of output.membership.sourceAggregateIds ?? []) {
      this.assertAggregateNamespace(sourceId, uid, agent);
      if (sourceId !== aggregateId) {
        this.db
          .prepare("update l2_aggregates set status = 'merged', merged_into_id = ?, updated_at = ? where id = ?")
          .run(aggregateId, createdAt, sourceId);
      }
      this.db
        .prepare(
          `insert into l2_aggregate_lineage
          (id, from_aggregate_id, to_aggregate_id, operation, run_id, reason, created_at)
          values (?, ?, ?, 'merge', ?, ?, ?)`
        )
        .run(nanoid(), sourceId, aggregateId, runId, output.provenance.reason, createdAt);
    }
  }

  private insertL1Revision(revision: L1TopicRevision): void {
    this.db
      .prepare(
        `insert into l1_topic_revisions
        (id, topic_id, version, status, title, summary, source_turn_ids, source_segment_id, stable_sequence,
         provider, model, prompt_version, schema_version, reason, confidence, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        revision.id,
        revision.topicId,
        revision.version,
        revision.status,
        revision.title,
        revision.summary,
        JSON.stringify(revision.sourceTurnIds),
        revision.sourceSegmentId,
        revision.stableSequence,
        revision.provider ?? null,
        revision.model ?? null,
        revision.promptVersion,
        revision.schemaVersion,
        revision.reason,
        revision.confidence,
        revision.createdAt
      );
  }

  private insertL1Lineage(runId: string, fromId: string, toId: string | null, operation: string, reason: string): void {
    this.db
      .prepare(
        `insert into l1_topic_lineage
        (id, from_topic_id, to_topic_id, operation, run_id, reason, created_at) values (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(nanoid(), fromId, toId, operation, runId, reason, now());
  }

  private assertTopicScope(topicId: string, scope: Scope, sessionId: string): void {
    const row = this.db.prepare("select uid, source, agent, channel, session_id from l1_topics where id = ?").get(topicId) as
      | { uid: string; source: string; agent: string; channel: string; session_id: string }
      | undefined;
    if (!row) throw new Error(`Unknown L1 Topic: ${topicId}`);
    if (row.uid !== scope.uid || row.source !== scope.source || row.agent !== scope.agent || row.channel !== scope.channel || row.session_id !== sessionId) {
      throw new Error(`L1 Topic is outside the maintenance scope: ${topicId}`);
    }
  }

  private assertTurnEvidence(scope: Scope, sessionId: string, turnIds: string[]): void {
    const rows = this.db
      .prepare(
        `select id from conversation_turns
         where uid = ? and source = ? and agent = ? and channel = ? and session_id = ?`
      )
      .all(scope.uid, scope.source, scope.agent, scope.channel, sessionId) as Array<{ id: string }>;
    const known = new Set(rows.map((row) => row.id));
    const unknown = turnIds.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`L1 plan references unknown Turn IDs: ${unknown.join(", ")}`);
  }

  private assertAggregateNamespace(aggregateId: string, uid: string, agent: string): void {
    const row = this.db.prepare("select uid, agent from l2_aggregates where id = ?").get(aggregateId) as
      | { uid: string; agent: string }
      | undefined;
    if (!row || row.uid !== uid || row.agent !== agent) throw new Error(`L2 Aggregate is outside namespace: ${aggregateId}`);
  }

  private getL1MaintenanceRun(id: string, _watermark?: number): L1MaintenanceRun | null {
    const row = this.db.prepare("select * from l1_maintenance_runs where id = ?").get(id) as L1RunRow | undefined;
    return row ? mapL1Run(row) : null;
  }

  private getL2AggregationRun(id: string): L2AggregationRun | null {
    const row = this.db.prepare("select * from l2_aggregation_runs where id = ?").get(id) as L2RunRow | undefined;
    return row ? mapL2Run(row) : null;
  }
}

type L1TopicRow = {
  id: string; session_id: string; status: L1Topic["status"]; current_revision_id: string; uid: string; source: string;
  agent: string; channel: string; metadata: string; created_at: string; updated_at: string;
};
type L1RevisionRow = {
  id: string; topic_id: string; version: number; status: L1TopicRevision["status"]; title: string; summary: string;
  source_turn_ids: string; source_segment_id: string | null; stable_sequence: number | null; provider: string | null;
  model: string | null; prompt_version: string; schema_version: string; reason: string; confidence: number; created_at: string;
};
type L1ComponentRow = {
  id: string; topic_revision_id: string; content: string; labels: string; evidence_turn_ids: string; provider: string | null;
  model: string | null; prompt_version: string; schema_version: string; reason: string; confidence: number; created_at: string;
};
type L1RunRow = {
  id: string; idempotency_key: string | null; uid: string; source: string; agent: string; channel: string; session_id: string; input_cutoff: string;
  output_watermark: number | null; status: L1MaintenanceRun["status"]; plan: string | null; error: string | null;
  started_at: string; ended_at: string | null;
};
type L2AggregateRow = {
  id: string; uid: string; agent: string; status: L2Aggregate["status"]; current_revision_id: string;
  merged_into_id: string | null; created_at: string; updated_at: string;
};
type L2RevisionRow = {
  id: string; aggregate_id: string; version: number; aggregate_type: string; canonical_title: string; aliases: string;
  external_keys: string; labels: string; summary: string;
  facts: string; decisions: string; constraints: string; open_questions: string; source_l1_watermark: number;
  provider: string | null; model: string | null; prompt_version: string; schema_version: string; reason: string;
  confidence: number; created_at: string;
};
type L2RunRow = {
  id: string; idempotency_key: string | null; uid: string; agent: string; source_l1_watermark: number; status: L2AggregationRun["status"];
  plan: string | null; error: string | null; started_at: string; ended_at: string | null;
};

function mapL1Topic(row: L1TopicRow): L1Topic {
  return { id: row.id, sessionId: row.session_id, status: row.status, currentRevisionId: row.current_revision_id,
    uid: row.uid, source: row.source, agent: row.agent, channel: row.channel, metadata: JSON.parse(row.metadata),
    createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapL1Revision(row: L1RevisionRow): L1TopicRevision {
  return { id: row.id, topicId: row.topic_id, version: row.version, status: row.status, title: row.title, summary: row.summary,
    sourceTurnIds: JSON.parse(row.source_turn_ids), sourceSegmentId: row.source_segment_id, stableSequence: row.stable_sequence,
    provider: row.provider ?? undefined, model: row.model ?? undefined, promptVersion: row.prompt_version,
    schemaVersion: row.schema_version, reason: row.reason, confidence: row.confidence, createdAt: row.created_at };
}
function mapL1Component(row: L1ComponentRow): L1Component {
  return { id: row.id, topicRevisionId: row.topic_revision_id, content: row.content, labels: JSON.parse(row.labels),
    evidenceTurnIds: JSON.parse(row.evidence_turn_ids), provider: row.provider ?? undefined, model: row.model ?? undefined,
    promptVersion: row.prompt_version, schemaVersion: row.schema_version, reason: row.reason,
    confidence: row.confidence, createdAt: row.created_at };
}
function mapL1Run(row: L1RunRow): L1MaintenanceRun {
  return { id: row.id, uid: row.uid, source: row.source, agent: row.agent, channel: row.channel, sessionId: row.session_id,
    inputCutoff: row.input_cutoff, outputWatermark: row.output_watermark, status: row.status,
    plan: row.plan ? JSON.parse(row.plan) : null, error: row.error, startedAt: row.started_at, endedAt: row.ended_at };
}
function mapL2Aggregate(row: L2AggregateRow): L2Aggregate {
  return { id: row.id, uid: row.uid, agent: row.agent, status: row.status, currentRevisionId: row.current_revision_id,
    mergedIntoId: row.merged_into_id, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapL2Revision(row: L2RevisionRow): L2AggregateRevision {
  return { id: row.id, aggregateId: row.aggregate_id, version: row.version, aggregateType: row.aggregate_type,
    canonicalTitle: row.canonical_title, aliases: JSON.parse(row.aliases), externalKeys: JSON.parse(row.external_keys),
    labels: JSON.parse(row.labels), summary: row.summary, facts: JSON.parse(row.facts),
    decisions: JSON.parse(row.decisions), constraints: JSON.parse(row.constraints), openQuestions: JSON.parse(row.open_questions),
    sourceL1Watermark: row.source_l1_watermark, provider: row.provider ?? undefined, model: row.model ?? undefined,
    promptVersion: row.prompt_version, schemaVersion: row.schema_version, reason: row.reason,
    confidence: row.confidence, createdAt: row.created_at };
}
function mapL2Run(row: L2RunRow): L2AggregationRun {
  return { id: row.id, uid: row.uid, agent: row.agent, sourceL1Watermark: row.source_l1_watermark, status: row.status,
    plan: row.plan ? JSON.parse(row.plan) : null, error: row.error, startedAt: row.started_at, endedAt: row.ended_at };
}
function unique(values: string[]): string[] { return Array.from(new Set(values)); }
function now(): string { return new Date().toISOString(); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "unknown error"; }
function digest(parts: string[]): string { return createHash("sha256").update(parts.join("\0")).digest("hex"); }
