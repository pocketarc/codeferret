/**
 * What a review says a lens could not reach, whatever the lens itself reported.
 *
 * Generated from the `standing-detail` frontmatter of review/lens-extras/*.md by
 * scripts/build-lens-agents.ts. Edit the extras file, not this one.
 */

export const STANDING_DETAIL: ReadonlyMap<string, string> = new Map([
    ["anthropic-accessibility-review", "No page was rendered, so contrast, focus order, target size, reflow, text spacing, timing limits and what an assistive technology announces were not evaluated."],
    ["copilot-web-design-reviewer", "No browser was available, so nothing was judged from a rendered page."],
    ["vercel-next-best-practices", "No application was used, so nothing was judged from a build, a bundle or a rendered page."],
]);
