import { Context } from "../types";
import { PluginSettings } from "../types/plugin-input";
import { isIssueAssignedEvent, isIssueCommentEvent } from "../types/typeguards";

export interface LanguageProofOfWork {
  language: string;
  repoCount: number;
  totalBytes: number;
  commitCount: number;
  passed: boolean;
}

/**
 * Extracts required programming languages from issue labels.
 * Supports formats such as "Experience: Solidity", "Solidity: 10", or "Solidity".
 */
export function extractRequiredLanguages(
  labels: Array<{ name?: string } | string>,
  config: Pick<PluginSettings, "labelPrefix" | "trackedLanguages">
): string[] {
  const prefix = config.labelPrefix.trim().toLowerCase();
  const trackedByLower = new Map(config.trackedLanguages.map((lang) => [lang.toLowerCase(), lang]));
  const found = new Map<string, string>();

  for (const rawLabel of labels) {
    const labelName = (typeof rawLabel === "string" ? rawLabel : rawLabel.name ?? "").trim();
    if (!labelName) continue;
    const lower = labelName.toLowerCase();

    if (prefix && lower.startsWith(prefix)) {
      const candidate = labelName.slice(prefix.length).trim().split(":")[0]?.trim();
      if (candidate) {
        const canonical = trackedByLower.get(candidate.toLowerCase()) ?? candidate;
        found.set(canonical.toLowerCase(), canonical);
      }
      continue;
    }

    const baseName = labelName.split(":")[0]?.trim() ?? "";
    const canonical = trackedByLower.get(baseName.toLowerCase());
    if (canonical) {
      found.set(canonical.toLowerCase(), canonical);
    }
  }

  return Array.from(found.values());
}

/**
 * Evaluates a contributor's public non-fork GitHub repositories, language bytes,
 * and authored commits for each required language.
 */
export async function evaluateContributorExperience(
  context: Context,
  username: string,
  requiredLanguages: string[]
): Promise<LanguageProofOfWork[]> {
  const { octokit, config, logger } = context;

  const { data: repos } = await octokit.rest.repos.listForUser({
    username,
    type: "owner",
    sort: "updated",
    per_page: config.maxReposToScan,
  });

  const ownRepos = repos.filter((repo) => !repo.fork && !repo.archived);
  const stats = new Map<string, { repoCount: number; totalBytes: number; commitCount: number }>();
  for (const lang of requiredLanguages) {
    stats.set(lang.toLowerCase(), { repoCount: 0, totalBytes: 0, commitCount: 0 });
  }

  for (const repo of ownRepos) {
    const { data: languages } = await octokit.rest.repos.listLanguages({
      owner: repo.owner.login,
      repo: repo.name,
    });

    const languageEntries = new Map(
      Object.entries(languages).map(([name, bytes]) => [name.toLowerCase(), bytes])
    );

    const matchedLangs = requiredLanguages.filter((lang) => (languageEntries.get(lang.toLowerCase()) ?? 0) > 0);
    if (matchedLangs.length === 0) continue;

    let authoredCommits = 0;
    try {
      const { data: commits } = await octokit.rest.repos.listCommits({
        owner: repo.owner.login,
        repo: repo.name,
        author: username,
        per_page: 30,
      });
      authoredCommits = commits.length;
    } catch (error) {
      logger.debug(`Skipping commit count for ${repo.full_name}`, {
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }

    for (const lang of matchedLangs) {
      const key = lang.toLowerCase();
      const entry = stats.get(key)!;
      entry.repoCount += 1;
      entry.totalBytes += languageEntries.get(key) ?? 0;
      entry.commitCount += authoredCommits;
    }
  }

  return requiredLanguages.map((language) => {
    const entry = stats.get(language.toLowerCase())!;
    const passed =
      entry.repoCount >= config.minReposPerLanguage &&
      entry.totalBytes >= config.minLanguageBytes &&
      entry.commitCount >= config.minCommitsInLanguageRepos;
    return {
      language,
      repoCount: entry.repoCount,
      totalBytes: entry.totalBytes,
      commitCount: entry.commitCount,
      passed,
    };
  });
}

function formatEvaluationComment(
  username: string,
  results: LanguageProofOfWork[],
  allPassed: boolean,
  config: PluginSettings
): string {
  const rows = results
    .map(
      (r) =>
        `| ${r.language} | ${r.repoCount} (min ${config.minReposPerLanguage}) | ${r.totalBytes} B (min ${config.minLanguageBytes} B) | ${r.commitCount} (min ${config.minCommitsInLanguageRepos}) | ${r.passed ? "Pass" : "Fail"} |`
    )
    .join("\n");

  const table = [
    "| Language | Non-Fork Repos | Code Bytes | Authored Commits | Status |",
    "| --- | --- | --- | --- | --- |",
    rows,
  ].join("\n");

  if (allPassed) {
    return [
      `> [!TIP]`,
      `> @${username} passed the GitHub proof-of-work experience check.`,
      "",
      table,
    ].join("\n");
  }

  const missing = results.filter((r) => !r.passed).map((r) => r.language).join(", ");
  return [
    `> [!WARNING]`,
    `> @${username} needs more **${missing}** proof-of-work on their public GitHub profile to be eligible for this task.`,
    "",
    table,
  ].join("\n");
}

export async function runExperienceCheck(context: Context): Promise<{ qualified: boolean; results: LanguageProofOfWork[] }> {
  const { payload, octokit, config, logger } = context;

  const issue = payload.issue;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const issueNumber = issue.number;

  const requiredLanguages = extractRequiredLanguages(issue.labels ?? [], config);
  if (requiredLanguages.length === 0) {
    logger.debug("No experience requirement labels found on issue; skipping check.");
    return { qualified: true, results: [] };
  }

  let targetUser: string | undefined;
  if (isIssueAssignedEvent(context)) {
    targetUser = context.payload.assignee?.login ?? issue.assignee?.login;
  } else if (isIssueCommentEvent(context)) {
    const body = context.payload.comment.body.trim();
    if (!/^\/start\b/i.test(body)) {
      return { qualified: true, results: [] };
    }
    targetUser = context.payload.comment.user?.login;
  }

  if (!targetUser) {
    logger.info("No target contributor login resolved; skipping experience check.");
    return { qualified: true, results: [] };
  }

  const { data: pendingComment } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: [
      `> [!NOTE]`,
      `> Please wait... Analyzing @${targetUser}'s public GitHub profile for **${requiredLanguages.join(", ")}** experience.`,
    ].join("\n"),
  });

  const results = await evaluateContributorExperience(context, targetUser, requiredLanguages);
  const qualified = results.every((r) => r.passed);

  await octokit.rest.issues.updateComment({
    owner,
    repo,
    comment_id: pendingComment.id,
    body: formatEvaluationComment(targetUser, results, qualified, config),
  });

  if (!qualified && config.unassignOnFailure && context.eventName === "issues.assigned") {
    await octokit.rest.issues.removeAssignees({
      owner,
      repo,
      issue_number: issueNumber,
      assignees: [targetUser],
    });
  }

  return { qualified, results };
}
