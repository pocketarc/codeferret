/**
 * What a review says a lens could not reach, whatever the lens itself reported.
 *
 * Generated from the `standing-detail` frontmatter of review/lens-extras/*.md by
 * scripts/build-lens-agents.ts. Edit the extras file, not this one.
 */

export const STANDING_DETAIL: ReadonlyMap<string, string> = new Map([
    ["anthropic-accessibility-review", "No page was rendered, so contrast, focus order, target size, reflow, text spacing, timing limits, flashing and what an assistive technology announces were not evaluated. Also not evaluated: whether a focus indicator is visible enough, whether anything that moves is distracting, and whether content revealed on hover is dismissible, hoverable and persistent."],
    ["copilot-sql-code-review", "No database was connected, so execution plans, index usage, redundant or fragmented indexes and query cost under load were not measured. Only the SQL in the diff and the schema and migration files it depends on were read."],
    ["copilot-web-design-reviewer", "No page was rendered, so element overflow and overlap, alignment and computed spacing, the mobile, tablet, desktop and wide viewport sweep, whether the resulting keyboard tab order is logical, whether text visibly clips or its ellipsis renders, focus-indicator visibility, whether a declared hover or active state is visually distinct enough, and layout shift on load were not evaluated. A contrast ratio or a target size is reported only where the diff, or a file read alongside it, settles the colour pair or the box outright; neither was reached otherwise."],
    ["vercel-next-best-practices", "No application was used, so nothing was judged from a build, a bundle or a rendered page."],
]);
