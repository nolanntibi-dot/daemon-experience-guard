import { Context } from "./context";

export function isIssueAssignedEvent(context: Context): context is Context<"issues.assigned"> {
  return context.eventName === "issues.assigned";
}

export function isIssueCommentEvent(context: Context): context is Context<"issue_comment.created"> {
  return context.eventName === "issue_comment.created";
}
