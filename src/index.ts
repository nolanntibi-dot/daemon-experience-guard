import { runExperienceCheck } from "./handlers/experience-check";
import { Context } from "./types";
import { isIssueAssignedEvent, isIssueCommentEvent } from "./types/typeguards";

/**
 * The main plugin function. Split for easier testing.
 */
export async function runPlugin(context: Context) {
  const { logger, eventName } = context;

  if (isIssueAssignedEvent(context) || isIssueCommentEvent(context)) {
    return await runExperienceCheck(context);
  }

  logger.error(`Unsupported event: ${eventName}`);
}
