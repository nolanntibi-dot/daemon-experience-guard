import { StaticDecode, Type as T } from "@sinclair/typebox";

/**
 * Configuration schema for the Developer Experience Guard plugin.
 * Evaluates a contributor's public GitHub proof-of-work before allowing assignment.
 */
export const pluginSettingsSchema = T.Object(
  {
    minReposPerLanguage: T.Number({
      default: 1,
      minimum: 1,
      description: "Minimum number of non-fork repositories containing the required language.",
    }),
    minLanguageBytes: T.Number({
      default: 5000,
      minimum: 0,
      description: "Minimum total bytes of code in the required language across non-fork repositories.",
    }),
    minCommitsInLanguageRepos: T.Number({
      default: 3,
      minimum: 0,
      description: "Minimum commits authored by the contributor in repositories containing the required language.",
    }),
    maxReposToScan: T.Number({
      default: 15,
      minimum: 1,
      maximum: 100,
      description: "Maximum number of non-fork repositories to inspect per contributor.",
    }),
    labelPrefix: T.String({
      default: "Experience:",
      description: "Optional label prefix used to declare required language experience (e.g. 'Experience: Solidity').",
    }),
    trackedLanguages: T.Array(T.String(), {
      default: ["Solidity", "TypeScript", "JavaScript", "Python", "Rust", "Go"],
      description: "Languages recognized from issue labels (either prefixed or standalone/scored like 'Solidity: 10').",
    }),
    unassignOnFailure: T.Boolean({
      default: true,
      description: "Whether to unassign the contributor when they do not meet the required experience thresholds.",
    }),
  },
  { default: {} }
);

export type PluginSettings = StaticDecode<typeof pluginSettingsSchema>;
