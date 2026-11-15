import { describe, expect, it, jest } from "@jest/globals";
import { Logs } from "@ubiquity-os/ubiquity-os-logger";
import { extractRequiredLanguages } from "../src/handlers/experience-check";
import { runPlugin } from "../src/index";
import { Context } from "../src/types";

function createMockContext(overrides: {
  eventName?: Context["eventName"];
  labels?: Array<{ name: string }>;
  assigneeLogin?: string;
  commentBody?: string;
  commentUser?: string;
  repos?: Array<{ name: string; full_name: string; fork: boolean; archived: boolean; owner: { login: string } }>;
  languagesByRepo?: Record<string, Record<string, number>>;
  commitsByRepo?: Record<string, number>;
}) {
  const createComment = jest.fn(async (_args?: unknown) => ({ data: { id: 101 } }));
  const updateComment = jest.fn(async (_args?: unknown) => ({ data: { id: 101 } }));
  const removeAssignees = jest.fn(async (_args?: unknown) => ({ data: {} }));
  const listForUser = jest.fn(async () => ({ data: overrides.repos ?? [] }));
  const listLanguages = jest.fn(async ({ repo }: { repo: string }) => ({
    data: overrides.languagesByRepo?.[repo] ?? {},
  }));
  const listCommits = jest.fn(async ({ repo }: { repo: string }) => ({
    data: Array.from({ length: overrides.commitsByRepo?.[repo] ?? 0 }, (_, idx) => ({ sha: `sha-${idx}` })),
  }));

  const eventName = overrides.eventName ?? "issues.assigned";
  const context = {
    eventName,
    logger: new Logs("debug"),
    config: {
      minReposPerLanguage: 1,
      minLanguageBytes: 5000,
      minCommitsInLanguageRepos: 3,
      maxReposToScan: 15,
      labelPrefix: "Experience:",
      trackedLanguages: ["Solidity", "TypeScript", "JavaScript", "Python", "Rust", "Go"],
      unassignOnFailure: true,
    },
    payload: {
      repository: {
        name: "ubiquity-dollar",
        owner: { login: "ubiquity" },
      },
      issue: {
        number: 927,
        labels: overrides.labels ?? [],
        assignee: overrides.assigneeLogin ? { login: overrides.assigneeLogin } : null,
      },
      assignee: overrides.assigneeLogin ? { login: overrides.assigneeLogin } : undefined,
      comment:
        eventName === "issue_comment.created"
          ? {
              body: overrides.commentBody ?? "/start",
              user: { login: overrides.commentUser ?? "alice" },
            }
          : undefined,
    },
    octokit: {
      rest: {
        issues: {
          createComment,
          updateComment,
          removeAssignees,
        },
        repos: {
          listForUser,
          listLanguages,
          listCommits,
        },
      },
    },
  } as unknown as Context;

  return { context, createComment, updateComment, removeAssignees };
}

describe("Developer Experience Guard plugin", () => {
  it("extracts required languages from prefixed, scored, and bare labels", () => {
    const langs = extractRequiredLanguages(
      [{ name: "Price: 300 USD" }, { name: "Experience: Solidity" }, { name: "TypeScript: 10" }, { name: "Rust" }],
      {
        labelPrefix: "Experience:",
        trackedLanguages: ["Solidity", "TypeScript", "Rust"],
      }
    );
    expect(langs).toEqual(["Solidity", "TypeScript", "Rust"]);
  });

  it("skips evaluation when no experience labels are present", async () => {
    const { context, createComment } = createMockContext({
      labels: [{ name: "Priority: 1 (Normal)" }],
      assigneeLogin: "alice",
    });

    const result = await runPlugin(context);
    expect(result).toEqual({ qualified: true, results: [] });
    expect(createComment).not.toHaveBeenCalled();
  });

  it("keeps assignment when contributor meets GitHub proof-of-work thresholds", async () => {
    const { context, createComment, updateComment, removeAssignees } = createMockContext({
      labels: [{ name: "Experience: Solidity" }],
      assigneeLogin: "soldev",
      repos: [
        { name: "vault-contracts", full_name: "soldev/vault-contracts", fork: false, archived: false, owner: { login: "soldev" } },
      ],
      languagesByRepo: {
        "vault-contracts": { Solidity: 18500, TypeScript: 4000 },
      },
      commitsByRepo: {
        "vault-contracts": 12,
      },
    });

    const result = await runPlugin(context);
    expect(result?.qualified).toBe(true);
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect(removeAssignees).not.toHaveBeenCalled();
  });

  it("unassigns contributor and updates comment when only forks or insufficient Solidity work exist", async () => {
    const { context, updateComment, removeAssignees } = createMockContext({
      labels: [{ name: "Solidity: 10" }],
      assigneeLogin: "newbie",
      repos: [
        { name: "forked-defi", full_name: "newbie/forked-defi", fork: true, archived: false, owner: { login: "newbie" } },
        { name: "personal-site", full_name: "newbie/personal-site", fork: false, archived: false, owner: { login: "newbie" } },
      ],
      languagesByRepo: {
        "forked-defi": { Solidity: 90000 },
        "personal-site": { HTML: 12000 },
      },
      commitsByRepo: {
        "forked-defi": 20,
        "personal-site": 5,
      },
    });

    const result = await runPlugin(context);
    expect(result?.qualified).toBe(false);
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect(removeAssignees).toHaveBeenCalledWith({
      owner: "ubiquity",
      repo: "ubiquity-dollar",
      issue_number: 927,
      assignees: ["newbie"],
    });
  });

  it("evaluates /start comments and ignores unrelated issue comments", async () => {
    const ignored = createMockContext({
      eventName: "issue_comment.created",
      labels: [{ name: "Experience: TypeScript" }],
      commentBody: "Looks interesting!",
      commentUser: "bob",
    });
    await runPlugin(ignored.context);
    expect(ignored.createComment).not.toHaveBeenCalled();

    const started = createMockContext({
      eventName: "issue_comment.created",
      labels: [{ name: "Experience: TypeScript" }],
      commentBody: "/start",
      commentUser: "bob",
      repos: [{ name: "ts-sdk", full_name: "bob/ts-sdk", fork: false, archived: false, owner: { login: "bob" } }],
      languagesByRepo: { "ts-sdk": { TypeScript: 9000 } },
      commitsByRepo: { "ts-sdk": 4 },
    });
    const res = await runPlugin(started.context);
    expect(res?.qualified).toBe(true);
    expect(started.createComment).toHaveBeenCalledTimes(1);
    expect(started.removeAssignees).not.toHaveBeenCalled();
  });
});
