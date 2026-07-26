// Effectively-once issue-delivery orchestration. This seam translates due
// milestones into delivery facts and tracker calls without owning event metadata.

import type {
  IssueBindingResolvedData,
  IssueDeliveryConfirmedData,
  IssueDeliveryFailedData,
  IssueDeliveryIntendedData,
  MilestoneKind,
} from "../runtime/events.ts";
import type { RunView } from "../runtime/reducer.ts";
import { canonicalPayloadHash } from "./hash.ts";
import { dueMilestones, marker } from "./milestones.ts";
import { renderMilestone } from "./render.ts";
import { IssueTrackerError, type IssueTracker } from "./tracker.ts";

export type IssueSyncEvent =
  | {
      readonly type: "issue_binding_resolved";
      readonly data: IssueBindingResolvedData;
    }
  | {
      readonly type: "issue_delivery_intended";
      readonly data: IssueDeliveryIntendedData;
    }
  | {
      readonly type: "issue_delivery_confirmed";
      readonly data: IssueDeliveryConfirmedData;
    }
  | {
      readonly type: "issue_delivery_failed";
      readonly data: IssueDeliveryFailedData;
    };

export interface ReconcileIssueSyncDeps {
  readonly loadRun: () => Promise<RunView>;
  readonly appendEvent: (event: IssueSyncEvent) => Promise<void>;
  readonly tracker: IssueTracker;
}

export type ReconcileDeliverySummary =
  | {
      readonly deliveryId: string;
      readonly kind: MilestoneKind;
      readonly outcome: "posted" | "backfilled";
    }
  | {
      readonly deliveryId: string;
      readonly kind: MilestoneKind;
      readonly outcome: "failed";
      readonly reason: string;
      readonly retryable: boolean;
    };

export interface ReconcileIssueSyncSummary {
  readonly deliveries: readonly ReconcileDeliverySummary[];
  readonly planningFailure: { readonly reason: string } | null;
}

function failureFor(error: unknown): {
  readonly reason: string;
  readonly retryable: boolean;
} {
  if (error instanceof IssueTrackerError) {
    return { reason: error.reason, retryable: error.retryable };
  }
  return {
    reason: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

/**
 * One reconciliation pass over a run's due milestones.
 *
 * Passes for one run must not overlap. Between a recorded intent and its
 * created comment the marker is legitimately absent, so a second pass entering
 * that window would miss it and post a second comment. The controller lease
 * excludes other processes; serializing a controller's own passes is the
 * caller's job.
 */
export async function reconcileIssueSync(
  deps: ReconcileIssueSyncDeps,
): Promise<ReconcileIssueSyncSummary> {
  let milestones;
  try {
    const run = await deps.loadRun();
    milestones = dueMilestones(run);
  } catch (error) {
    return {
      deliveries: [],
      planningFailure: { reason: failureFor(error).reason },
    };
  }
  const deliveries: ReconcileDeliverySummary[] = [];

  for (const milestone of milestones) {
    try {
      const payloadHash = canonicalPayloadHash(milestone.payload);
      let current = await deps.loadRun();
      const delivery = current.deliveries[milestone.deliveryId];
      if (
        delivery !== undefined &&
        delivery.payloadHash !== payloadHash
      ) {
        const reason =
          `payload hash conflict for delivery "${milestone.deliveryId}": ` +
          `recorded ${delivery.payloadHash}, computed ${payloadHash}`;
        if (delivery.state === "failed") {
          await deps.appendEvent({
            type: "issue_delivery_intended",
            data: {
              deliveryId: delivery.deliveryId,
              kind: delivery.kind,
              laneId: delivery.laneId,
              payloadHash: delivery.payloadHash,
            },
          });
        }
        await deps.appendEvent({
          type: "issue_delivery_failed",
          data: {
            deliveryId: milestone.deliveryId,
            reason,
            retryable: false,
          },
        });
        deliveries.push({
          deliveryId: milestone.deliveryId,
          kind: milestone.kind,
          outcome: "failed",
          reason,
          retryable: false,
        });
        continue;
      }
      if (delivery === undefined || delivery.state === "failed") {
        await deps.appendEvent({
          type: "issue_delivery_intended",
          data: {
            deliveryId: milestone.deliveryId,
            kind: milestone.kind,
            laneId: milestone.laneId,
            payloadHash,
          },
        });
        current = await deps.loadRun();
      }
      if (current.issue === null) {
        throw new Error("due milestone belongs to an unbound run");
      }
      const issue = current.issue;
      if (current.issueNodeId === null) {
        const resolved = await deps.tracker.resolveIssue(issue);
        await deps.appendEvent({
          type: "issue_binding_resolved",
          data: { issueNodeId: resolved.nodeId },
        });
        current = await deps.loadRun();
      }
      const existing = await deps.tracker.findCommentByMarker(
        issue,
        marker(milestone.deliveryId),
      );
      if (existing !== null) {
        const labels = await deps.tracker.readCurrentLabels(issue);
        const labelTransition =
          milestone.kind === "blocked"
            ? labels.includes("needs-info")
              ? "applied"
              : "skipped"
            : "not-applicable";
        await deps.appendEvent({
          type: "issue_delivery_confirmed",
          data: {
            deliveryId: milestone.deliveryId,
            ...existing,
            labelTransition,
          },
        });
        deliveries.push({
          deliveryId: milestone.deliveryId,
          kind: milestone.kind,
          outcome: "backfilled",
        });
        continue;
      }

      const labelTransition =
        milestone.kind === "blocked"
          ? await deps.tracker.compareAndSetTriageLabel(
              issue,
              "ready-for-agent",
              "needs-info",
            )
          : "not-applicable";
      const created = await deps.tracker.createComment(
        issue,
        renderMilestone(milestone, { labelTransition }),
      );
      await deps.appendEvent({
        type: "issue_delivery_confirmed",
        data: {
          deliveryId: milestone.deliveryId,
          ...created,
          labelTransition,
        },
      });
      deliveries.push({
        deliveryId: milestone.deliveryId,
        kind: milestone.kind,
        outcome: "posted",
      });
    } catch (error) {
      const failure = failureFor(error);
      try {
        const current = await deps.loadRun();
        if (
          current.deliveries[milestone.deliveryId]?.state === "pending"
        ) {
          await deps.appendEvent({
            type: "issue_delivery_failed",
            data: {
              deliveryId: milestone.deliveryId,
              ...failure,
            },
          });
        }
      } catch {
        // The caller still receives the classified failure when the ledger
        // itself cannot accept the durable failure fact.
      }
      deliveries.push({
        deliveryId: milestone.deliveryId,
        kind: milestone.kind,
        outcome: "failed",
        ...failure,
      });
    }
  }

  return { deliveries, planningFailure: null };
}
