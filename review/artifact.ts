/**
 * What the action's upload step declares, for the run that reads an artifact back.
 *
 * The name is protocol between the step that writes the artifact and the run that opens it,
 * and nothing older than the retention window is still downloadable, so paging past it walks
 * artifacts GitHub has already deleted.
 *
 * Generated from action.yml by scripts/build-defaults.ts. Edit action.yml, not this file.
 */

export const ARTIFACT_NAME = "codeferret-run";
export const RETENTION_DAYS = 14;
