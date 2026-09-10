import { describe, expect, it } from "vitest";
import { buildCatalogSnapshot } from "./catalog.js";
import { searchTools } from "./discovery.js";
import { toCodeModeTool } from "./eligibility.js";
import { loadGithubFixture } from "./fixtures.js";

/**
 * Retrieval quality gates.
 *
 * Progressive discovery only works if search actually finds the right tool. If
 * it does not, the model's recovery is to enumerate — which is the eager
 * catalog again, paid for one page at a time. So the token win is only real if
 * these numbers hold, and they are release-blocking for that reason.
 *
 * Queries are phrased the way a model asks, not the way the tools are named,
 * and are graded against the real 85-tool github-mcp-server surface.
 *
 * Measured baseline: Recall@3/@5/@10 = 1.00, MRR = 0.953,
 * selection_accuracy_given_hit = 0.92. Only "who am i authenticated as"
 * (get_me, rank 3) and "add a comment to an issue" (rank 2) are not first.
 *
 * The thresholds sit well below that on purpose: they are a regression floor,
 * not a claim about real retrieval quality. These queries are hand-written and
 * lexically close to the tool surface, so passing here is necessary and not
 * sufficient — model-generated queries in PDE are the honest measurement.
 */

interface LabelledQuery {
  readonly query: string;
  /** Any of these counts as correct — several tools legitimately fit. */
  readonly gold: readonly string[];
}

const QUERIES: readonly LabelledQuery[] = [
  { query: "how many issues are assigned to me", gold: ["list_issues", "search_issues"] },
  { query: "read the contents of a file in a repository", gold: ["get_file_contents"] },
  { query: "merge a pull request", gold: ["merge_pull_request"] },
  { query: "list open pull requests", gold: ["list_pull_requests"] },
  { query: "create a new branch", gold: ["create_branch"] },
  { query: "star a repository", gold: ["star_repository"] },
  { query: "dependabot alerts", gold: ["list_dependabot_alerts", "get_dependabot_alert"] },
  {
    query: "code scanning alerts",
    gold: ["list_code_scanning_alerts", "get_code_scanning_alert"],
  },
  {
    query: "secret scanning alerts",
    gold: ["list_secret_scanning_alerts", "get_secret_scanning_alert"],
  },
  { query: "mark all notifications as read", gold: ["mark_all_notifications_read"] },
  { query: "workflow job logs", gold: ["get_job_logs"] },
  { query: "trigger a workflow run", gold: ["actions_run_trigger"] },
  { query: "who am i authenticated as", gold: ["get_me"] },
  { query: "members of a team", gold: ["get_team_members"] },
  { query: "create a gist", gold: ["create_gist"] },
  { query: "list tags", gold: ["list_tags"] },
  { query: "latest release", gold: ["get_latest_release"] },
  { query: "fork a repository", gold: ["fork_repository"] },
  { query: "search code across repositories", gold: ["search_code"] },
  { query: "add a comment to an issue", gold: ["add_issue_comment", "issue_write"] },
  { query: "push files to a repository", gold: ["push_files"] },
  { query: "request a copilot review", gold: ["request_copilot_review"] },
  { query: "list discussions", gold: ["list_discussions"] },
  { query: "repository file tree", gold: ["get_repository_tree"] },
  { query: "delete a file", gold: ["delete_file"] },
];

const snapshot = buildCatalogSnapshot(loadGithubFixture().map((tool) => toCodeModeTool(tool)));

/** Rank of the first gold hit, 1-based, or 0 when none appears within `limit`. */
function goldRank(entry: LabelledQuery, limit: number): number {
  const result = searchTools(snapshot, entry.query, { limit });
  if ("error" in result) throw new Error(`search failed: ${result.message}`);
  const gold = new Set(entry.gold.map((name) => `github/${name}`));
  const index = result.hits.findIndex((hit) => gold.has(hit.ref));
  return index === -1 ? 0 : index + 1;
}

function recallAt(k: number): number {
  const found = QUERIES.filter((entry) => goldRank(entry, k) > 0).length;
  return found / QUERIES.length;
}

describe("code mode retrieval quality", () => {
  it("finds a correct tool within the default page for nearly every query", () => {
    const misses = QUERIES.filter((entry) => goldRank(entry, 5) === 0).map((entry) => entry.query);
    // Reported rather than merely counted: a bare ratio tells you the gate
    // broke, the list tells you which phrasings regressed.
    expect(misses).toEqual([]);
    expect(recallAt(5)).toBeGreaterThanOrEqual(0.9);
  });

  it("ranks the correct tool near the top", () => {
    const reciprocal = QUERIES.map((entry) => {
      const rank = goldRank(entry, 10);
      return rank === 0 ? 0 : 1 / rank;
    });
    const mrr = reciprocal.reduce((sum, value) => sum + value, 0) / QUERIES.length;
    expect(mrr).toBeGreaterThanOrEqual(0.75);
  });

  it("puts the right tool first once it has found it at all", () => {
    // Separate from recall on purpose. Retrieving the tool somewhere in the
    // page and retrieving it *first* are different failures: the first costs
    // the model a read, the second costs it a wrong call.
    const hits = QUERIES.map((entry) => goldRank(entry, 10)).filter((rank) => rank > 0);
    const selectionAccuracy = hits.filter((rank) => rank === 1).length / hits.length;
    expect(selectionAccuracy).toBeGreaterThanOrEqual(0.7);
  });

  it("does not depend on a generous page size", () => {
    // Sensitivity to k. If recall collapses at 3 the ranking is not really
    // working and a lucky cap is doing the job.
    const at3 = recallAt(3);
    const at5 = recallAt(5);
    const at10 = recallAt(10);

    expect(at3).toBeGreaterThanOrEqual(0.8);
    expect(at5).toBeGreaterThanOrEqual(at3);
    expect(at10).toBeGreaterThanOrEqual(at5);
    // Widening the page five-fold should not be what rescues retrieval.
    expect(at10 - at3).toBeLessThanOrEqual(0.2);
  });
});
