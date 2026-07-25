import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const ACK_MARKER = "<!-- nora-community-ack:v1 -->";
export const REMINDER_MARKER = "<!-- nora-community-reminder:v1 -->";
export const DAY_MS = 24 * 60 * 60 * 1000;
export const REMINDER_AFTER_MS = 12 * DAY_MS;
export const OVERDUE_AFTER_MS = 14 * DAY_MS;

const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function isMaintainerAssociation(value) {
  return MAINTAINER_ASSOCIATIONS.has(String(value || "").toUpperCase());
}

export function isExternalThread({ authorAssociation, authorType } = {}) {
  return (
    !isMaintainerAssociation(authorAssociation) && String(authorType || "").toLowerCase() !== "bot"
  );
}

export function hasMarker(comments = [], marker) {
  return comments.some((comment) => String(comment?.body || "").includes(marker));
}

export function hasMaintainerResponse(comments = [], reviews = []) {
  return [...comments, ...reviews].some((item) =>
    isMaintainerAssociation(item?.authorAssociation ?? item?.author_association),
  );
}

export function classifyResponseState(
  { createdAt, comments = [], reviews = [] } = {},
  now = Date.now(),
) {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) {
    throw new Error(`Invalid community thread creation time: ${createdAt}`);
  }
  const elapsedMs = Math.max(0, now - created);
  const humanResponse = hasMaintainerResponse(comments, reviews);
  return {
    elapsedMs,
    humanResponse,
    needsReminder:
      !humanResponse && elapsedMs >= REMINDER_AFTER_MS && !hasMarker(comments, REMINDER_MARKER),
    overdue: !humanResponse && elapsedMs >= OVERDUE_AFTER_MS,
  };
}

export function pullRequestResponseStart({ createdAt, draft = false, timeline = [] } = {}) {
  if (draft) return null;
  let latestReadyAt = null;
  let latestReadyMs = Number.NEGATIVE_INFINITY;
  for (const event of timeline) {
    if (event?.event !== "ready_for_review") continue;
    const candidate = event.created_at ?? event.createdAt;
    const candidateMs = new Date(candidate).getTime();
    if (Number.isFinite(candidateMs) && candidateMs > latestReadyMs) {
      latestReadyAt = candidate;
      latestReadyMs = candidateMs;
    }
  }
  return latestReadyAt || createdAt;
}

function threadLabel(kind) {
  if (kind === "pull request") return "pull request";
  if (kind === "discussion") return "discussion";
  return "issue";
}

export function buildAcknowledgement(kind) {
  const label = threadLabel(kind);
  const routing =
    kind === "pull request"
      ? "Please keep the validation notes and affected subsystems current while review is pending."
      : kind === "discussion"
        ? "Setup questions and design tradeoffs belong here; reproducible bugs should move to an issue."
        : "Security-sensitive details must use the private SECURITY.md reporting path instead of this thread.";
  return `${ACK_MARKER}\n\nThanks for opening this ${label}. This automated acknowledgement confirms it is in Nora's public response queue. A human maintainer aims to respond within fourteen days.\n\n${routing}`;
}

export function buildReminder(kind) {
  const label = threadLabel(kind);
  return `${REMINDER_MARKER}\n\n@solomon2773 this external ${label} is approaching Nora's fourteen-day human-response target. Please add a maintainer acknowledgement, request the missing information, or route it to the appropriate support or security path.`;
}

function repositoryCoordinates(value = process.env.GITHUB_REPOSITORY) {
  const [owner, repo, extra] = String(value || "").split("/");
  if (!owner || !repo || extra) {
    throw new Error("GITHUB_REPOSITORY must use owner/repo format");
  }
  return { owner, repo };
}

function githubHeaders(token = process.env.GITHUB_TOKEN) {
  if (!token) throw new Error("GITHUB_TOKEN is required");
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "nora-community-response",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubRequest(path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: githubHeaders(),
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(
      `GitHub API ${method} ${path} failed (${response.status}): ${text.slice(0, 500)}`,
    );
  }
  return { payload, headers: response.headers };
}

async function graphql(query, variables) {
  const { payload } = await githubRequest("/graphql", {
    method: "POST",
    body: { query, variables },
  });
  if (payload?.errors?.length) {
    throw new Error(`GitHub GraphQL failed: ${JSON.stringify(payload.errors)}`);
  }
  return payload?.data;
}

async function paginate(path) {
  const values = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const { payload } = await githubRequest(`${path}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(payload)) throw new Error(`Expected an array from ${path}`);
    values.push(...payload);
    if (payload.length < 100) return values;
  }
}

async function issueComments(owner, repo, number) {
  return paginate(`/repos/${owner}/${repo}/issues/${number}/comments`);
}

async function pullReviews(owner, repo, number) {
  return paginate(`/repos/${owner}/${repo}/pulls/${number}/reviews`);
}

async function pullRequestResponseClock(owner, repo, issue) {
  const { payload: pullRequest } = await githubRequest(
    `/repos/${owner}/${repo}/pulls/${issue.number}`,
  );
  const timeline = await paginate(`/repos/${owner}/${repo}/issues/${issue.number}/timeline`);
  return pullRequestResponseStart({
    createdAt: issue.created_at,
    draft: pullRequest?.draft === true,
    timeline,
  });
}

async function postIssueComment(owner, repo, number, body) {
  await githubRequest(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: "POST",
    body: { body },
  });
}

async function remainingDiscussionReplies(commentId, cursor) {
  const replies = [];
  let nextCursor = cursor;
  while (nextCursor) {
    const data = await graphql(
      `
        query NoraDiscussionReplies($commentId: ID!, $cursor: String) {
          node(id: $commentId) {
            ... on DiscussionComment {
              replies(first: 100, after: $cursor) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  body
                  authorAssociation
                }
              }
            }
          }
        }
      `,
      { commentId, cursor: nextCursor },
    );
    const connection = data?.node?.replies;
    if (!connection) throw new Error(`Discussion comment ${commentId} was not found`);
    replies.push(...(connection.nodes || []));
    nextCursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  }
  return replies;
}

async function discussionComments(owner, repo, number) {
  const comments = [];
  let discussionId = null;
  let cursor = null;

  do {
    const data = await graphql(
      `
        query NoraDiscussionComments(
          $owner: String!
          $repo: String!
          $number: Int!
          $cursor: String
        ) {
          repository(owner: $owner, name: $repo) {
            discussion(number: $number) {
              id
              comments(first: 100, after: $cursor) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  id
                  body
                  authorAssociation
                  replies(first: 100) {
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                    nodes {
                      body
                      authorAssociation
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { owner, repo, number, cursor },
    );
    const discussion = data?.repository?.discussion;
    if (!discussion) throw new Error(`Discussion #${number} was not found`);
    discussionId = discussion.id;
    const connection = discussion.comments;
    for (const comment of connection?.nodes || []) {
      comments.push(comment, ...(comment.replies?.nodes || []));
      if (comment.replies?.pageInfo?.hasNextPage) {
        comments.push(
          ...(await remainingDiscussionReplies(comment.id, comment.replies.pageInfo.endCursor)),
        );
      }
    }
    cursor = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);

  return { id: discussionId, comments };
}

async function postDiscussionComment(discussionId, body) {
  await graphql(
    `
      mutation NoraAddDiscussionComment($discussionId: ID!, $body: String!) {
        addDiscussionComment(input: { discussionId: $discussionId, body: $body }) {
          comment {
            id
          }
        }
      }
    `,
    { discussionId, body },
  );
}

async function acknowledge() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const eventName = process.env.GITHUB_EVENT_NAME;
  const { owner, repo } = repositoryCoordinates();

  if (eventName === "discussion") {
    const thread = event.discussion;
    if (
      !thread ||
      !isExternalThread({
        authorAssociation: thread.author_association,
        authorType: thread.user?.type,
      })
    ) {
      return;
    }
    const current = await discussionComments(owner, repo, thread.number);
    if (!hasMarker(current.comments, ACK_MARKER)) {
      await postDiscussionComment(current.id, buildAcknowledgement("discussion"));
    }
    return;
  }

  const thread = eventName === "pull_request_target" ? event.pull_request : event.issue;
  if (
    !thread ||
    (eventName === "pull_request_target" && thread.draft === true) ||
    !isExternalThread({
      authorAssociation: thread.author_association,
      authorType: thread.user?.type,
    })
  ) {
    return;
  }
  const comments = await issueComments(owner, repo, thread.number);
  if (!hasMarker(comments, ACK_MARKER)) {
    await postIssueComment(
      owner,
      repo,
      thread.number,
      buildAcknowledgement(eventName === "pull_request_target" ? "pull request" : "issue"),
    );
  }
}

async function openDiscussions(owner, repo) {
  const discussions = [];
  let cursor = null;
  do {
    const data = await graphql(
      `
        query NoraOpenDiscussions($owner: String!, $repo: String!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            discussions(
              first: 100
              after: $cursor
              states: [OPEN]
              orderBy: { field: CREATED_AT, direction: ASC }
            ) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                number
                title
                url
                createdAt
                authorAssociation
                author {
                  login
                }
              }
            }
          }
        }
      `,
      { owner, repo, cursor },
    );
    const connection = data?.repository?.discussions;
    if (!connection) throw new Error("Repository Discussions are unavailable");
    discussions.push(...(connection.nodes || []));
    cursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);
  return discussions;
}

async function writeStepSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const { appendFile } = await import("node:fs/promises");
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

async function audit() {
  const { owner, repo } = repositoryCoordinates();
  const now = Date.now();
  const reminders = [];
  const overdue = [];
  const issues = await paginate(
    `/repos/${owner}/${repo}/issues?state=open&sort=created&direction=asc`,
  );

  for (const issue of issues) {
    if (
      !isExternalThread({
        authorAssociation: issue.author_association,
        authorType: issue.user?.type,
      })
    ) {
      continue;
    }
    const kind = issue.pull_request ? "pull request" : "issue";
    const responseStart = issue.pull_request
      ? await pullRequestResponseClock(owner, repo, issue)
      : issue.created_at;
    if (!responseStart) continue;
    const comments = await issueComments(owner, repo, issue.number);
    const reviews = issue.pull_request ? await pullReviews(owner, repo, issue.number) : [];
    const state = classifyResponseState({ createdAt: responseStart, comments, reviews }, now);
    if (state.needsReminder) {
      await postIssueComment(owner, repo, issue.number, buildReminder(kind));
      reminders.push(`${kind} #${issue.number}`);
    }
    if (state.overdue) overdue.push(`${kind} #${issue.number}`);
  }

  for (const discussion of await openDiscussions(owner, repo)) {
    if (
      !isExternalThread({
        authorAssociation: discussion.authorAssociation,
        authorType: discussion.author?.login?.endsWith("[bot]") ? "Bot" : "User",
      })
    ) {
      continue;
    }
    const current = await discussionComments(owner, repo, discussion.number);
    const comments = current.comments;
    const state = classifyResponseState({ createdAt: discussion.createdAt, comments }, now);
    if (state.needsReminder) {
      await postDiscussionComment(current.id, buildReminder("discussion"));
      reminders.push(`discussion #${discussion.number}`);
    }
    if (state.overdue) overdue.push(`discussion #${discussion.number}`);
  }

  await writeStepSummary([
    "## Community response audit",
    "",
    `- Pre-deadline reminders posted: ${reminders.length ? reminders.join(", ") : "none"}`,
    `- Beyond the fourteen-day human-response target: ${overdue.length ? overdue.join(", ") : "none"}`,
  ]);

  if (overdue.length) {
    throw new Error(`Human response target exceeded: ${overdue.join(", ")}`);
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "acknowledge") return acknowledge();
  if (command === "audit") return audit();
  throw new Error("Usage: community-response.mjs <acknowledge|audit>");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
