import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import type {
  CorrectionRecord,
  CorrectionStatus,
  CreateCorrectionInput,
  GenerationProvenance,
  GovernanceFreshness,
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
  L2Statement,
  StatementDraft,
  StatementLineageEdge,
  StatementOperation,
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
  statementOperations?: StatementOperation[];
  provenance: GenerationProvenance;
}

type StatementSource = {
  sourceRef: string;
  revisionId: string;
  statementId: string;
  category: "facts" | "decisions" | "constraints" | "openQuestions";
  content: string;
};

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

  createCorrection(input: CreateCorrectionInput): CorrectionRecord {
    validateCorrectionAction(input);
    const target = this.resolveCorrectionTarget(input);
    const payloadHash = digest([
      input.uid,
      input.agent,
      input.targetType,
      input.targetId,
      input.targetRevisionId ?? "",
      target.affectedSource ?? "",
      target.affectedChannel ?? "",
      target.affectedSessionId ?? "",
      input.action,
      input.correctedContent ?? "",
      input.reason,
      "human_correction"
    ]);
    const existing = this.db
      .prepare("select * from correction_records where uid = ? and agent = ? and event_id = ?")
      .get(input.uid, input.agent, input.eventId) as CorrectionRow | undefined;
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw new Error("Correction idempotency conflict");
      return mapCorrection(existing);
    }

    const id = nanoid();
    const createdAt = now();
    return this.db.transaction(() => {
      const createdSequence = this.insertNamespaceChange(
        input.uid,
        input.agent,
        "correction_created",
        input.targetType,
        id,
        id,
        createdAt
      );
      const status: CorrectionStatus = input.targetType === "l2_statement" ? "ready_l2" : "pending_l1";
      const readySequence =
        status === "ready_l2"
          ? this.insertNamespaceChange(input.uid, input.agent, "correction_ready", input.targetType, id, id, createdAt)
          : null;
      this.db
        .prepare(
          `insert into correction_records
          (id, event_id, payload_hash, uid, agent, target_type, target_id, target_revision_id, action, corrected_content,
           reason, authority, status, affected_source, affected_channel, affected_session_id, created_sequence, ready_sequence,
           applied_sequence, error, created_at, updated_at, applied_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human_correction', ?, ?, ?, ?, ?, ?, null, null, ?, ?, null)`
        )
        .run(
          id,
          input.eventId,
          payloadHash,
          input.uid,
          input.agent,
          input.targetType,
          input.targetId,
          input.targetRevisionId,
          input.action,
          input.correctedContent,
          input.reason,
          status,
          target.affectedSource,
          target.affectedChannel,
          target.affectedSessionId,
          createdSequence,
          readySequence,
          createdAt,
          createdAt
        );
      return this.getCorrection(input.uid, input.agent, id)!;
    })();
  }

  getCorrection(uid: string, agent: string, id: string): CorrectionRecord | null {
    const row = this.db
      .prepare("select * from correction_records where id = ? and uid = ? and agent = ?")
      .get(id, uid, agent) as CorrectionRow | undefined;
    return row ? mapCorrection(row) : null;
  }

  listCorrections(filter: { uid: string; agent: string; status?: CorrectionStatus; limit?: number }): CorrectionRecord[] {
    const limit = filter.limit ?? 20;
    const rows = filter.status
      ? this.db
          .prepare("select * from correction_records where uid = ? and agent = ? and status = ? order by created_sequence asc limit ?")
          .all(filter.uid, filter.agent, filter.status, limit)
      : this.db
          .prepare("select * from correction_records where uid = ? and agent = ? order by created_sequence asc limit ?")
          .all(filter.uid, filter.agent, limit);
    return (rows as CorrectionRow[]).map(mapCorrection);
  }

  getGovernanceFreshness(uid: string, agent: string): GovernanceFreshness {
    const pending = this.db
      .prepare(
        `select coalesce(max(
          case
            when status = 'pending_l1' then created_sequence
            when status = 'ready_l2' then ready_sequence
            else applied_sequence
          end
        ), 0) as latest, count(*) as count
        from correction_records
        where uid = ? and agent = ? and status != 'applied'`
      )
      .get(uid, agent) as { latest: number | null; count: number };
    const latestAny = this.db
      .prepare(
        `select coalesce(max(
          case
            when status = 'pending_l1' then created_sequence
            when status = 'ready_l2' then ready_sequence
            else applied_sequence
          end
        ), 0) as latest
        from correction_records
        where uid = ? and agent = ?`
      )
      .get(uid, agent) as { latest: number | null };
    const checkpoint = this.db
      .prepare("select governance_watermark from l2_checkpoints where uid = ? and agent = ?")
      .get(uid, agent) as { governance_watermark: number } | undefined;

    return {
      status: pending.count > 0 ? "pending_reconciliation" : "current",
      pendingCorrectionCount: pending.count,
      latestGovernanceSequence: latestAny.latest ?? 0,
      appliedGovernanceSequence: checkpoint?.governance_watermark ?? 0
    };
  }

  listPendingL1CorrectionSessions(): Array<{ scope: Scope; sessionId: string }> {
    const rows = this.db
      .prepare(
        `select uid, affected_source, agent, affected_channel, affected_session_id
        from correction_records
        where status = 'pending_l1'
          and affected_source is not null
          and affected_channel is not null
          and affected_session_id is not null
        group by uid, affected_source, agent, affected_channel, affected_session_id
        order by min(created_sequence) asc`
      )
      .all() as Array<{
      uid: string;
      affected_source: string;
      agent: string;
      affected_channel: string;
      affected_session_id: string;
    }>;
    return rows.map((row) => ({
      scope: {
        uid: row.uid,
        source: row.affected_source,
        agent: row.agent,
        channel: row.affected_channel,
        metadata: {}
      },
      sessionId: row.affected_session_id
    }));
  }

  listReadyL2CorrectionNamespaces(): Array<{ uid: string; agent: string }> {
    return this.db
      .prepare(
        `select uid, agent
        from correction_records
        where status = 'ready_l2'
        group by uid, agent
        order by min(ready_sequence) asc`
      )
      .all() as Array<{ uid: string; agent: string }>;
  }

  listDueL2Namespaces(): Array<{ uid: string; agent: string }> {
    const byKey = new Map<string, { uid: string; agent: string }>();
    const stableRows = this.db
      .prepare(
        `select s.uid, s.agent
        from l1_stable_sequence s
        left join l2_checkpoints c on c.uid = s.uid and c.agent = s.agent
        group by s.uid, s.agent
        having max(s.sequence) > coalesce(c.l1_stable_watermark, 0)
        order by max(s.sequence) asc`
      )
      .all() as Array<{ uid: string; agent: string }>;
    for (const row of stableRows) byKey.set(`${row.uid}\0${row.agent}`, row);
    for (const row of this.listReadyL2CorrectionNamespaces()) byKey.set(`${row.uid}\0${row.agent}`, row);
    return Array.from(byKey.values());
  }

  listPendingL1CorrectionsForSession(scope: Scope, sessionId: string): CorrectionRecord[] {
    const rows = this.db
      .prepare(
        `select * from correction_records
        where uid = ? and agent = ? and status = 'pending_l1'
          and affected_source = ? and affected_channel = ? and affected_session_id = ?
        order by created_sequence asc`
      )
      .all(scope.uid, scope.agent, scope.source, scope.channel, sessionId) as CorrectionRow[];
    return rows.map(mapCorrection);
  }

  listReadyL2Corrections(uid: string, agent: string): CorrectionRecord[] {
    const rows = this.db
      .prepare("select * from correction_records where uid = ? and agent = ? and status = 'ready_l2' order by ready_sequence asc")
      .all(uid, agent) as CorrectionRow[];
    return rows.map(mapCorrection);
  }

  listStatementLineage(uid: string, agent: string): StatementLineageEdge[] {
    const rows = this.db
      .prepare("select * from statement_lineage_edges where uid = ? and agent = ? order by created_at asc, id asc")
      .all(uid, agent) as StatementLineageRow[];
    return rows.map((row) => ({
      fromRevisionId: row.from_revision_id,
      fromStatementId: row.from_statement_id,
      toRevisionId: row.to_revision_id,
      toStatementId: row.to_statement_id,
      operation: row.operation
    }));
  }

  upsertL2Checkpoint(uid: string, agent: string, l1StableWatermark: number, governanceWatermark: number, runId: string): void {
    this.db
      .prepare(
        `insert into l2_checkpoints
        (uid, agent, l1_stable_watermark, governance_watermark, run_id, prompt_version, schema_version, updated_at)
        values (?, ?, ?, ?, ?, 'manual', 'v2', ?)
        on conflict(uid, agent) do update set
          l1_stable_watermark = excluded.l1_stable_watermark,
          governance_watermark = excluded.governance_watermark,
          run_id = excluded.run_id,
          updated_at = excluded.updated_at`
      )
      .run(uid, agent, l1StableWatermark, governanceWatermark, runId, now());
  }

  runL1Maintenance(
    scope: Scope,
    sessionId: string,
    inputCutoff: string,
    plan: L1MaintenancePlan,
    provenance: Omit<GenerationProvenance, "reason" | "confidence">,
    snapshotHash?: string
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
    if (snapshotHash) {
      this.db
        .prepare("update l1_maintenance_runs set input_snapshot_hash = ?, prompt_version = ?, schema_version = ? where id = ?")
        .run(snapshotHash, provenance.promptVersion, provenance.schemaVersion, runId);
    }

    try {
      const outputWatermark = this.db.transaction(() => {
        const dueCorrections = this.listPendingL1CorrectionsForSession(scope, sessionId);
        assertHandledCorrectionIds(dueCorrections, plan.handledCorrectionIds ?? [], "L1 plan omitted pending Correction");
        let watermark = this.getL1StableWatermark(scope.uid, scope.agent);
        for (const item of plan.items) {
          watermark = Math.max(watermark, this.applyL1PlanItem(runId, scope, sessionId, item, provenance));
        }
        this.markCorrectionsReady(dueCorrections);
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

  getSuccessfulL1RunBySnapshot(scope: Scope, sessionId: string, snapshotHash: string): L1MaintenanceRun | null {
    const row = this.db
      .prepare(
        `select * from l1_maintenance_runs
        where uid = ? and source = ? and agent = ? and channel = ? and session_id = ?
          and status = 'success' and input_snapshot_hash = ?
        order by ended_at desc limit 1`
      )
      .get(scope.uid, scope.source, scope.agent, scope.channel, sessionId, snapshotHash) as L1RunRow | undefined;
    return row ? mapL1Run(row) : null;
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
    return { aggregate, revision: mapL2Revision(revisionRow, aggregate.uid, aggregate.agent), componentIds: memberships.map((row) => row.component_id) };
  }

  runL2Aggregation(
    uid: string,
    agent: string,
    watermark: number,
    plan: L2MembershipPlan,
    outputs: L2SynthesisOutput[],
    snapshotHash?: string,
    sourceGovernanceWatermark = 0
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
    if (snapshotHash) {
      this.db
        .prepare("update l2_aggregation_runs set input_snapshot_hash = ?, source_governance_watermark = ? where id = ?")
        .run(snapshotHash, sourceGovernanceWatermark, runId);
    }
    try {
      this.db.transaction(() => {
        const dueCorrections = this.listReadyL2Corrections(uid, agent);
        assertHandledCorrectionIds(dueCorrections, plan.handledCorrectionIds ?? [], "L2 plan omitted ready Correction");
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
          this.applyL2Output(runId, uid, agent, watermark, output, allowed, dueCorrections);
        }
        const appliedWatermark = this.markCorrectionsApplied(dueCorrections);
        const currentCheckpoint = this.db
          .prepare("select governance_watermark from l2_checkpoints where uid = ? and agent = ?")
          .get(uid, agent) as { governance_watermark: number } | undefined;
        this.upsertL2Checkpoint(
          uid,
          agent,
          watermark,
          Math.max(currentCheckpoint?.governance_watermark ?? 0, appliedWatermark),
          runId
        );
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

  getSuccessfulL2RunBySnapshot(uid: string, agent: string, snapshotHash: string): L2AggregationRun | null {
    const row = this.db
      .prepare(
        `select * from l2_aggregation_runs
        where uid = ? and agent = ? and status = 'success' and input_snapshot_hash = ?
        order by ended_at desc limit 1`
      )
      .get(uid, agent, snapshotHash) as L2RunRow | undefined;
    return row ? mapL2Run(row) : null;
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
      const evidenceTurnIds = component.evidenceTurnIds ?? [];
      if (evidenceTurnIds.some((id) => !sourceTurnIds.includes(id))) {
        throw new Error("L1 component references evidence outside its Topic revision");
      }
      const evidenceCorrectionIds = component.evidenceCorrectionIds ?? [];
      this.assertL1CorrectionEvidence(scope, sessionId, evidenceCorrectionIds);
      if (evidenceTurnIds.length === 0 && evidenceCorrectionIds.length === 0) {
        throw new Error("L1 component requires Turn or Correction evidence");
      }
      const evidenceAuthority = evidenceCorrectionIds.length > 0 ? "human_correction" : "conversation";
      this.db
        .prepare(
          `insert into l1_components
          (id, topic_revision_id, content, labels, evidence_turn_ids, provider, model, prompt_version, schema_version,
           reason, confidence, created_at, evidence_authority, evidence_correction_ids)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          nanoid(),
          revisionId,
          component.content,
          JSON.stringify(component.labels ?? []),
          JSON.stringify(evidenceTurnIds),
          provenance.provider ?? null,
          provenance.model ?? null,
          provenance.promptVersion,
          provenance.schemaVersion,
          item.reason,
          component.confidence ?? item.confidence,
          createdAt,
          evidenceAuthority,
          JSON.stringify(evidenceCorrectionIds)
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
    allowedComponents: Set<string>,
    dueCorrections: CorrectionRecord[]
  ): void {
    for (const componentId of output.membership.componentIds) {
      if (!allowedComponents.has(componentId)) throw new Error(`L2 plan references unavailable Component: ${componentId}`);
    }
    const membershipSet = new Set(output.membership.componentIds);
    const aggregateId = output.membership.aggregateId ?? nanoid();
    const existing = this.getL2AggregateView(aggregateId);
    if (existing) this.assertAggregateNamespace(aggregateId, uid, agent);
    const createdAt = now();
    const revisionId = nanoid();
    const sourceStatements = existing ? sourceStatementsForView(existing) : [];
    const outputContent = output.statementOperations
      ? {
          ...output.content,
          facts: applyStatementOperations(
            output.statementOperations,
            sourceStatements,
            dueCorrections,
            output.membership.componentIds,
            revisionId,
            uid,
            agent,
            this.db
          ),
          decisions: [],
          constraints: [],
          openQuestions: []
        }
      : output.content;

    for (const statement of [
      ...outputContent.facts,
      ...outputContent.decisions,
      ...outputContent.constraints,
      ...outputContent.openQuestions
    ]) {
      const evidenceComponentIds = statement.evidenceComponentIds ?? [];
      const evidenceCorrectionIds = statement.evidenceCorrectionIds ?? [];
      if (evidenceComponentIds.some((id) => !membershipSet.has(id))) {
        throw new Error("L2 statement references evidence outside its validated Membership");
      }
      assertL2CorrectionEvidence(evidenceCorrectionIds, dueCorrections);
      if (evidenceComponentIds.length === 0 && evidenceCorrectionIds.length === 0) {
        throw new Error("L2 statement requires Component or Correction evidence");
      }
      validateStatementConflict(statement);
    }

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
        outputContent.aggregateType,
        outputContent.canonicalTitle,
        JSON.stringify(outputContent.aliases),
        JSON.stringify(outputContent.externalKeys),
        JSON.stringify(outputContent.labels),
        outputContent.summary,
        JSON.stringify(outputContent.facts),
        JSON.stringify(outputContent.decisions),
        JSON.stringify(outputContent.constraints),
        JSON.stringify(outputContent.openQuestions),
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

  private assertL1CorrectionEvidence(scope: Scope, sessionId: string, correctionIds: string[]): void {
    if (correctionIds.length === 0) return;
    const rows = this.db
      .prepare(
        `select id from correction_records
        where uid = ? and agent = ?
          and affected_source = ? and affected_channel = ? and affected_session_id = ?`
      )
      .all(scope.uid, scope.agent, scope.source, scope.channel, sessionId) as Array<{ id: string }>;
    const known = new Set(rows.map((row) => row.id));
    const unknown = correctionIds.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`L1 component references out-of-scope Correction IDs: ${unknown.join(", ")}`);
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

  private insertNamespaceChange(
    uid: string,
    agent: string,
    kind: string,
    entityType: string,
    entityId: string,
    correctionId: string | null,
    createdAt: string
  ): number {
    const result = this.db
      .prepare(
        `insert into namespace_changes
        (uid, agent, kind, entity_type, entity_id, correction_id, created_at)
        values (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(uid, agent, kind, entityType, entityId, correctionId, createdAt);
    return Number(result.lastInsertRowid);
  }

  private markCorrectionsReady(corrections: CorrectionRecord[]): void {
    for (const correction of corrections) {
      const timestamp = now();
      const readySequence = this.insertNamespaceChange(
        correction.uid,
        correction.agent,
        "correction_ready",
        correction.targetType,
        correction.id,
        correction.id,
        timestamp
      );
      this.db
        .prepare("update correction_records set status = 'ready_l2', ready_sequence = ?, updated_at = ? where id = ? and status = 'pending_l1'")
        .run(readySequence, timestamp, correction.id);
    }
  }

  private markCorrectionsApplied(corrections: CorrectionRecord[]): number {
    let maxAppliedSequence = 0;
    for (const correction of corrections) {
      const timestamp = now();
      const appliedSequence = this.insertNamespaceChange(
        correction.uid,
        correction.agent,
        "correction_applied",
        correction.targetType,
        correction.id,
        correction.id,
        timestamp
      );
      maxAppliedSequence = Math.max(maxAppliedSequence, appliedSequence);
      this.db
        .prepare(
          "update correction_records set status = 'applied', applied_sequence = ?, updated_at = ?, applied_at = ? where id = ? and status = 'ready_l2'"
        )
        .run(appliedSequence, timestamp, timestamp, correction.id);
    }
    return maxAppliedSequence;
  }

  private resolveCorrectionTarget(input: CreateCorrectionInput): {
    affectedSource: string | null;
    affectedChannel: string | null;
    affectedSessionId: string | null;
  } {
    if (input.targetType === "turn") {
      if (!input.source || !input.channel || !input.sessionId) throw new Error("Turn correction requires source, channel, and sessionId");
      const row = this.db
        .prepare(
          `select id from conversation_turns
           where id = ? and uid = ? and source = ? and agent = ? and channel = ? and session_id = ?`
        )
        .get(input.targetId, input.uid, input.source, input.agent, input.channel, input.sessionId) as { id: string } | undefined;
      if (!row) throw new Error("Correction target not found");
      return { affectedSource: input.source, affectedChannel: input.channel, affectedSessionId: input.sessionId };
    }
    if (input.targetType === "l1_component") {
      if (!input.source || !input.channel || !input.sessionId) throw new Error("L1 Component correction requires source, channel, and sessionId");
      const row = this.db
        .prepare(
          `select c.id from l1_components c
           join l1_topic_revisions r on r.id = c.topic_revision_id
           join l1_topics t on t.id = r.topic_id
           where c.id = ? and t.uid = ? and t.source = ? and t.agent = ? and t.channel = ? and t.session_id = ?`
        )
        .get(input.targetId, input.uid, input.source, input.agent, input.channel, input.sessionId) as { id: string } | undefined;
      if (!row) throw new Error("Correction target not found");
      return { affectedSource: input.source, affectedChannel: input.channel, affectedSessionId: input.sessionId };
    }
    if (input.source || input.channel || input.sessionId) throw new Error("L2 Statement correction rejects source, channel, and sessionId");
    if (!input.targetRevisionId) throw new Error("L2 Statement correction requires targetRevisionId");
    const staleRevision = this.db
      .prepare(
        `select a.id, a.current_revision_id from l2_aggregates a
         join l2_aggregate_revisions r on r.aggregate_id = a.id
         where a.uid = ? and a.agent = ? and r.id = ? and a.current_revision_id != ?`
      )
      .get(input.uid, input.agent, input.targetRevisionId, input.targetRevisionId) as { id: string; current_revision_id: string } | undefined;
    if (staleRevision) throw new Error(`L2 Statement correction target is stale; currentRevisionId=${staleRevision.current_revision_id}`);
    const aggregate = this.db
      .prepare(
        `select a.id from l2_aggregates a
         join l2_aggregate_revisions r on r.id = a.current_revision_id
         where a.uid = ? and a.agent = ? and r.id = ?`
      )
      .get(input.uid, input.agent, input.targetRevisionId) as { id: string } | undefined;
    if (!aggregate) throw new Error("Correction target not found");
    const view = this.getL2AggregateView(aggregate.id);
    const statements = view
      ? [
          ...view.revision.facts,
          ...view.revision.decisions,
          ...view.revision.constraints,
          ...view.revision.openQuestions
        ]
      : [];
    if (!statements.some((statement) => statement.id === input.targetId)) throw new Error("Correction target not found");
    return { affectedSource: null, affectedChannel: null, affectedSessionId: null };
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
  evidence_authority: L1Component["evidenceAuthority"]; evidence_correction_ids: string;
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
type CorrectionRow = {
  id: string; event_id: string; payload_hash: string; uid: string; agent: string; target_type: CorrectionRecord["targetType"];
  target_id: string; target_revision_id: string | null; action: CorrectionRecord["action"]; corrected_content: string | null;
  reason: string; authority: "human_correction"; status: CorrectionStatus; affected_source: string | null;
  affected_channel: string | null; affected_session_id: string | null; created_sequence: number; ready_sequence: number | null;
  applied_sequence: number | null; error: string | null; created_at: string; updated_at: string; applied_at: string | null;
};
type StatementLineageRow = {
  id: string; uid: string; agent: string; from_revision_id: string; from_statement_id: string; to_revision_id: string | null;
  to_statement_id: string | null; operation: StatementLineageEdge["operation"]; created_at: string;
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
    confidence: row.confidence, evidenceAuthority: row.evidence_authority, evidenceCorrectionIds: JSON.parse(row.evidence_correction_ids),
    createdAt: row.created_at };
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
function mapL2Revision(row: L2RevisionRow, uid: string, agent: string): L2AggregateRevision {
  const facts = normalizeL2Statements(JSON.parse(row.facts) as L2Statement[], { uid, agent, aggregateId: row.aggregate_id, revisionId: row.id, category: "facts" });
  const decisions = normalizeL2Statements(JSON.parse(row.decisions) as L2Statement[], {
    uid,
    agent,
    aggregateId: row.aggregate_id,
    revisionId: row.id,
    category: "decisions"
  });
  const constraints = normalizeL2Statements(JSON.parse(row.constraints) as L2Statement[], {
    uid,
    agent,
    aggregateId: row.aggregate_id,
    revisionId: row.id,
    category: "constraints"
  });
  const openQuestions = normalizeL2Statements(JSON.parse(row.open_questions) as L2Statement[], {
    uid,
    agent,
    aggregateId: row.aggregate_id,
    revisionId: row.id,
    category: "open_questions"
  });
  return { id: row.id, aggregateId: row.aggregate_id, version: row.version, aggregateType: row.aggregate_type,
    canonicalTitle: row.canonical_title, aliases: JSON.parse(row.aliases), externalKeys: JSON.parse(row.external_keys),
    labels: JSON.parse(row.labels), summary: row.summary, facts,
    decisions, constraints, openQuestions,
    sourceL1Watermark: row.source_l1_watermark, provider: row.provider ?? undefined, model: row.model ?? undefined,
    promptVersion: row.prompt_version, schemaVersion: row.schema_version, reason: row.reason,
    confidence: row.confidence, createdAt: row.created_at };
}
function mapL2Run(row: L2RunRow): L2AggregationRun {
  return { id: row.id, uid: row.uid, agent: row.agent, sourceL1Watermark: row.source_l1_watermark, status: row.status,
    plan: row.plan ? JSON.parse(row.plan) : null, error: row.error, startedAt: row.started_at, endedAt: row.ended_at };
}
function mapCorrection(row: CorrectionRow): CorrectionRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    payloadHash: row.payload_hash,
    uid: row.uid,
    agent: row.agent,
    targetType: row.target_type,
    targetId: row.target_id,
    targetRevisionId: row.target_revision_id,
    action: row.action,
    correctedContent: row.corrected_content,
    reason: row.reason,
    authority: row.authority,
    status: row.status,
    affectedSource: row.affected_source,
    affectedChannel: row.affected_channel,
    affectedSessionId: row.affected_session_id,
    createdSequence: row.created_sequence,
    readySequence: row.ready_sequence,
    appliedSequence: row.applied_sequence,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at
  };
}
function unique(values: string[]): string[] { return Array.from(new Set(values)); }
function now(): string { return new Date().toISOString(); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "unknown error"; }
function digest(parts: string[]): string { return createHash("sha256").update(parts.join("\0")).digest("hex"); }
function assertHandledCorrectionIds(dueCorrections: CorrectionRecord[], handledIds: string[], message: string): void {
  const due = dueCorrections.map((correction) => correction.id).sort();
  const handled = [...handledIds].sort();
  if (new Set(handledIds).size !== handledIds.length) throw new Error(`${message}: duplicate handled Correction`);
  if (due.length !== handled.length || due.some((id, index) => id !== handled[index])) {
    throw new Error(`${message}: ${due.filter((id) => !handled.includes(id)).join(", ")}`);
  }
}
function validateCorrectionAction(input: CreateCorrectionInput): void {
  if (input.action === "replace" && !input.correctedContent) throw new Error("replace requires correctedContent");
  if (input.action === "retract" && input.correctedContent !== null) throw new Error("retract rejects correctedContent");
}
function assertL2CorrectionEvidence(evidenceCorrectionIds: string[], dueCorrections: CorrectionRecord[]): void {
  const allowed = new Set(dueCorrections.map((correction) => correction.id));
  const unknown = evidenceCorrectionIds.filter((id) => !allowed.has(id));
  if (unknown.length) throw new Error(`L2 statement references out-of-snapshot Correction IDs: ${unknown.join(", ")}`);
}
function validateStatementConflict(statement: L2Statement): void {
  const status = statement.status ?? "supported";
  const conflict = statement.conflictAssessment ?? null;
  if (status === "supported" && conflict) throw new Error("supported Statement rejects conflictAssessment");
  if (status === "contested") {
    if (!conflict) throw new Error("contested Statement requires conflictAssessment");
    const supporting = conflict.supportingEvidenceRefs.map((ref) => `${ref.kind}:${ref.id}`);
    const conflicting = conflict.conflictingEvidenceRefs.map((ref) => `${ref.kind}:${ref.id}`);
    if (supporting.length === 0 || conflicting.length === 0) throw new Error("contested Statement requires supporting and conflicting evidence");
    if (supporting.some((ref) => conflicting.includes(ref))) throw new Error("contested Statement evidence groups must be disjoint");
    if (conflict.alternatives.length < 2) throw new Error("contested Statement requires alternatives");
  }
}
function sourceStatementsForView(view: L2AggregateView): StatementSource[] {
  const sourceStatements: StatementSource[] = [];
  let index = 0;
  for (const category of ["facts", "decisions", "constraints", "openQuestions"] as const) {
    for (const statement of view.revision[category]) {
      if (!statement.id) throw new Error("L2 source Statement is missing an ID");
      sourceStatements.push({
        sourceRef: `s${index++}`,
        revisionId: view.revision.id,
        statementId: statement.id,
        category,
        content: statement.content
      });
    }
  }
  return sourceStatements;
}
function applyStatementOperations(
  operations: StatementOperation[],
  sources: StatementSource[],
  dueCorrections: CorrectionRecord[],
  membershipComponentIds: string[],
  toRevisionId: string,
  uid: string,
  agent: string,
  db: Database.Database
): L2Statement[] {
  const byRef = new Map(sources.map((source) => [source.sourceRef, source]));
  const consumed = new Set<string>();
  const statements: L2Statement[] = [];
  const correctedSourceRefs = new Map<string, CorrectionRecord>();
  for (const correction of dueCorrections.filter((item) => item.targetType === "l2_statement")) {
    const source = sources.find((item) => item.revisionId === correction.targetRevisionId && item.statementId === correction.targetId);
    if (!source) throw new Error(`L2 Correction target source is not in synthesis snapshot: ${correction.id}`);
    correctedSourceRefs.set(source.sourceRef, correction);
  }

  for (const operation of operations) {
    if (operation.op === "create") {
      statements.push(normalizeStatementDraft(operation.statement, nanoid(), dueCorrections, membershipComponentIds));
      continue;
    }
    if (operation.op === "continue") {
      const source = consumeSource(operation.sourceRef, byRef, consumed);
      const correction = correctedSourceRefs.get(operation.sourceRef);
      if (correction?.action === "retract") throw new Error("L2 retract Correction requires retire");
      if (correction?.action === "replace" && !(operation.statement.evidenceCorrectionIds ?? []).includes(correction.id)) {
        throw new Error("L2 replace Correction successor must cite the Correction");
      }
      const statement = normalizeStatementDraft(operation.statement, source.statementId, dueCorrections, membershipComponentIds);
      statements.push(statement);
      insertStatementLineage(db, uid, agent, source, toRevisionId, source.statementId, "continue");
      continue;
    }
    if (operation.op === "retire") {
      const source = consumeSource(operation.sourceRef, byRef, consumed);
      insertStatementLineage(db, uid, agent, source, toRevisionId, null, "retire");
      continue;
    }
    if (operation.op === "merge") {
      if (operation.sourceRefs.length < 2) throw new Error("merge requires at least two sources");
      const newId = nanoid();
      const statement = normalizeStatementDraft(operation.statement, newId, dueCorrections, membershipComponentIds);
      statements.push(statement);
      for (const sourceRef of operation.sourceRefs) {
        const source = consumeSource(sourceRef, byRef, consumed);
        insertStatementLineage(db, uid, agent, source, toRevisionId, newId, "merge");
      }
      continue;
    }
    const source = consumeSource(operation.sourceRef, byRef, consumed);
    for (const draft of operation.statements) {
      const newId = nanoid();
      statements.push(normalizeStatementDraft(draft, newId, dueCorrections, membershipComponentIds));
      insertStatementLineage(db, uid, agent, source, toRevisionId, newId, "split");
    }
  }

  for (const [sourceRef, correction] of correctedSourceRefs) {
    if (!consumed.has(sourceRef)) throw new Error(`L2 Statement Correction was not mapped to a source operation: ${correction.id}`);
  }
  return statements;
}
function consumeSource(sourceRef: string, byRef: Map<string, StatementSource>, consumed: Set<string>): StatementSource {
  const source = byRef.get(sourceRef);
  if (!source) throw new Error(`Unknown Statement sourceRef: ${sourceRef}`);
  if (consumed.has(sourceRef)) throw new Error(`Statement sourceRef consumed more than once: ${sourceRef}`);
  consumed.add(sourceRef);
  return source;
}
function normalizeStatementDraft(
  draft: StatementDraft,
  id: string,
  dueCorrections: CorrectionRecord[],
  membershipComponentIds: string[]
): L2Statement {
  const evidenceComponentIds = draft.evidenceComponentIds ?? [];
  const evidenceCorrectionIds = draft.evidenceCorrectionIds ?? [];
  const statement: L2Statement = {
    id,
    content: draft.content,
    evidenceComponentIds,
    evidenceCorrectionIds,
    semanticOrigin: "derived",
    evidenceAuthority: evidenceCorrectionIds.length > 0 ? "human_correction" : "conversation",
    status: draft.status ?? "supported",
    conflictAssessment: draft.conflictAssessment ?? null,
    confidence: draft.confidence,
    qualifier: draft.qualifier
  };
  if (statement.evidenceComponentIds.some((componentId) => !membershipComponentIds.includes(componentId))) {
    throw new Error("Statement operation references Component outside Membership");
  }
  assertL2CorrectionEvidence(statement.evidenceCorrectionIds ?? [], dueCorrections);
  validateStatementConflict(statement);
  return statement;
}
function insertStatementLineage(
  db: Database.Database,
  uid: string,
  agent: string,
  source: StatementSource,
  toRevisionId: string,
  toStatementId: string | null,
  operation: StatementLineageEdge["operation"]
): void {
  db.prepare(
    `insert into statement_lineage_edges
    (id, uid, agent, from_revision_id, from_statement_id, to_revision_id, to_statement_id, operation, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(nanoid(), uid, agent, source.revisionId, source.statementId, toRevisionId, toStatementId, operation, now());
}
function normalizeL2Statements(
  statements: L2Statement[],
  context: { uid: string; agent: string; aggregateId: string; revisionId: string; category: string }
): L2Statement[] {
  return statements.map((statement, index) => {
    const evidenceCorrectionIds = statement.evidenceCorrectionIds ?? [];
    return {
      id: statement.id ?? legacyStatementId({ ...context, index }),
      content: statement.content,
      evidenceComponentIds: statement.evidenceComponentIds,
      evidenceCorrectionIds,
      semanticOrigin: statement.semanticOrigin ?? "derived",
      evidenceAuthority: evidenceCorrectionIds.length > 0 ? "human_correction" : statement.evidenceAuthority ?? "conversation",
      status: statement.status ?? "supported",
      conflictAssessment: statement.conflictAssessment ?? null,
      confidence: statement.confidence,
      qualifier: statement.qualifier
    };
  });
}
function legacyStatementId(input: {
  uid: string;
  agent: string;
  aggregateId: string;
  revisionId: string;
  category: string;
  index: number;
}): string {
  return digest([
    "omm:legacy-statement:v1",
    input.uid,
    input.agent,
    input.aggregateId,
    input.revisionId,
    input.category,
    String(input.index)
  ]).slice(0, 36);
}
