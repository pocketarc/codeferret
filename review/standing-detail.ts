/**
 * What a review says a lens could not reach, whatever the lens itself reported.
 *
 * Generated from the `standing-detail` frontmatter of review/lens-extras/*.md by
 * scripts/build-lens-agents.ts. Edit the extras file, not this one.
 */

export const STANDING_DETAIL: ReadonlyMap<string, string> = new Map([
    ["anthropic-accessibility-review", "No page was rendered, so focus order, reflow, text spacing, timing limits, flashing and what an assistive technology announces were not evaluated. A contrast ratio or a target size is reported only where the source settles the colour pair or the border box outright; neither was reached otherwise. Also not evaluated: whether a focus indicator is visible enough, whether anything that moves is distracting, and whether content revealed on hover is dismissible, hoverable and persistent."],
    ["copilot-sql-code-review", "No database was connected, so execution plans, index usage, redundant or fragmented indexes and query cost under load were not measured. Only the SQL in the diff and the schema and migration files it depends on were read."],
    ["copilot-web-design-reviewer", "No page was rendered, so nothing that depends on one was evaluated, among them element overflow and overlap, alignment and computed spacing, the mobile, tablet, desktop and wide viewport sweep, whether the resulting keyboard tab order is logical, whether text visibly clips or its ellipsis renders, computed line height and characters per line, focus-indicator visibility, whether a declared hover, active, disabled or loading state is visually distinct enough, whether a chart or a diagram is still legible with a colour vision difference, how an image renders at another pixel density or what stands in for it when it fails to load, and layout shift on load. A contrast ratio or a target size is reported only where the diff, or a file read alongside it, settles the colour pair or the box outright; neither was reached otherwise."],
    ["vercel-next-best-practices", "No application was used, so nothing that needs a build or a running server was measured, among them bundle size and import chains, per-route output size, which routes were prerendered, the server's errors, route map and logs, and whether a custom cache handler shares revalidated pages across instances. A hydration mismatch was judged from the source causes of one alone, never from comparing the server output against the client output on a rendered page."],
]);
