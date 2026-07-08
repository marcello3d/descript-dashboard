import type { TrunkMergeState, TrunkStatus } from "@/types";

// The Trunk merge-queue bot. GraphQL reports the actor login as "trunk-io";
// the REST API uses the "[bot]" suffix. Match either.
export const TRUNK_BOT_LOGINS = ["trunk-io", "trunk-io[bot]"];

const DETAILS_URL_RE = /https:\/\/app\.trunk\.io\/[^\s)>\]]+/;
const SUBMIT_CHECKBOX_MARKER = "<!-- Start PR Submit Checkbox -->";
const STICKY_MARKER = "<!-- Trunk Merge -->";

// The leading emoji Trunk uses on its sticky comment maps to a queue state.
// Order matters: the failed/canceled comments also carry the submit checkbox
// (they're re-submittable), so the emoji is checked before falling back to it.
const EMOJI_STATE: [string, TrunkMergeState][] = [
  ["😎", "merged"],
  ["🧪", "testing"],
  ["⏳", "waiting_batch"],
  ["✨", "submitted"],
  ["❌", "failed"],
  ["🚫", "canceled"],
];

const LABELS: Record<TrunkMergeState, string> = {
  awaiting: "Not queued",
  submitted: "Queued · waiting for checks",
  waiting_batch: "Queued · waiting for a batch",
  testing: "Testing in merge queue",
  merged: "Merged",
  failed: "Merge failed",
  canceled: "Merge canceled",
};

// Parse a single trunk-io[bot] sticky comment body into a TrunkStatus.
// Returns null when the body doesn't look like a Trunk merge comment.
export function parseTrunkComment(body: string | null | undefined): TrunkStatus | null {
  if (!body) return null;
  const trimmed = body.trimStart();
  const canSubmit = body.includes(SUBMIT_CHECKBOX_MARKER);

  let state: TrunkMergeState | null = null;
  for (const [emoji, s] of EMOJI_STATE) {
    if (trimmed.startsWith(emoji)) {
      state = s;
      break;
    }
  }
  if (!state && (canSubmit || body.includes(STICKY_MARKER))) {
    state = "awaiting";
  }
  if (!state) return null;

  return {
    state,
    label: LABELS[state],
    canSubmit,
    detailsUrl: body.match(DETAILS_URL_RE)?.[0] ?? null,
  };
}

// Find the Trunk sticky comment among a PR's issue comments and parse it.
export function trunkStatusFromComments(
  comments: { author: string | null | undefined; body: string }[]
): TrunkStatus | null {
  const trunkComment = comments.find(
    (c) => c.author != null && TRUNK_BOT_LOGINS.includes(c.author)
  );
  return trunkComment ? parseTrunkComment(trunkComment.body) : null;
}
