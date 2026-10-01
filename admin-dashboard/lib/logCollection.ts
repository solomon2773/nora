// Logic behind the "Log collection" settings card and the undecided banner,
// kept out of the components so it can be tested without rendering them.
//
// The API is backend-api's GET/PUT /admin/log-collection
// (routes/observability.ts).

export interface LogCollectionStats {
  segments: number;
  lines: number;
  bytes: number;
  agents: number;
  spans: number;
  oldest: string | null;
  newest: string | null;
}

export type PurgeStatus = "pending" | "running" | "completed" | "failed";

export interface PurgeJob {
  id: string;
  status: PurgeStatus;
  requestedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  segmentsDeleted?: number;
  spansDeleted?: number;
  error?: string | null;
}

export interface LogCollectionState {
  enabled: boolean;
  /** false until an admin (or setup / .env) has made a choice */
  decided: boolean;
  source: "database" | "env" | "default";
  envValue: boolean | null;
  stats: LogCollectionStats;
  purge: PurgeJob | null;
  encryptionKeyProblem: string | null;
}

export const EMPTY_STATS: LogCollectionStats = {
  segments: 0,
  lines: 0,
  bytes: 0,
  agents: 0,
  spans: 0,
  oldest: null,
  newest: null,
};

/** Is there anything a "delete" would actually remove? Decides whether to ask. */
export function hasCollectedLogs(stats: Partial<LogCollectionStats> | null | undefined): boolean {
  return Number(stats?.segments || 0) > 0 || Number(stats?.spans || 0) > 0;
}

/** A delete-everything request that has not finished. */
export function purgeInProgress(job: Pick<PurgeJob, "status"> | null | undefined): boolean {
  return job?.status === "pending" || job?.status === "running";
}

export type CollectionHeadline = "on" | "off" | "undecided";

export function collectionHeadline(
  state: Pick<LogCollectionState, "enabled" | "decided"> | null | undefined,
): CollectionHeadline {
  if (!state) return "undecided";
  if (state.enabled) return "on";
  return state.decided ? "off" : "undecided";
}

/**
 * Whether to show the "not decided yet" banner: only once we know the answer
 * (a failed or pending fetch must not flash a banner) and only until dismissed.
 */
export function shouldShowUndecidedBanner(
  state: Pick<LogCollectionState, "decided"> | null | undefined,
  dismissed: boolean,
): boolean {
  return Boolean(state) && state!.decided === false && !dismissed;
}

/**
 * What the API said went wrong, in words an admin can act on. Falls back to the
 * server's own message, which is already written for people.
 */
export function describeCollectionError(
  payload: { code?: string; error?: string } | null | undefined,
  status: number,
): string {
  if (payload?.error) return payload.error;
  return `Request failed (${status})`;
}

/** True when the server says the disable request needs a keep-or-delete answer. */
export function needsKeepOrDelete(
  status: number,
  payload: { code?: string } | null | undefined,
): boolean {
  return status === 400 && payload?.code === "delete_existing_required";
}
