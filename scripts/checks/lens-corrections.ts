/**
 * That every correction in `review/lens-extras/` still quotes text the vendored skill has.
 *
 * A lens loads the vendored skill and the extras together, and the extras corrects the skill
 * by quoting it. The skill is pinned in `lenses/skills/PROVENANCE.tsv`, and nothing tied a
 * quotation to the pin, so a re-vendor at a commit where upstream has fixed one of them
 * leaves the lens carrying a second, contradictory instruction into every review, and
 * nothing fails.
 *
 * `checkSkillFences` is the same shape of problem already solved once: a deliberate edit to a
 * vendored file that a re-vendor would otherwise drop in silence. This is the larger deliberate
 * edit to the same pinned material.
 *
 * One fragment per correction, and each fragment has to stop matching once upstream fixes
 * what the correction is about. A single line of the vendored file usually carries that.
 * Where the defect is a pairing rather than a line (a predicate in the wrong clause of a
 * join, a column list with no key under it), the fragment spans the lines whose pairing is
 * the defect, because either line alone survives the fix.
 *
 * A presence check cannot bind a correction whose substance is an absence. Widening the
 * fragment across the line an addition would have to be inserted at covers most of them;
 * where even that leaves the correction unbound, say so in the comment beside the quote, so
 * nobody reads a green `OK lens-extras` as "every correction is still true".
 *
 * What each fragment stands for is the paragraph that quotes it, so add a line here whenever
 * you add a correction to an extras file.
 */

import { existsSync } from "node:fs";
import { fail } from "./support.ts";
import type { Failures } from "./support.ts";

interface Correction {
    /** The vendored file the quotations are from, under `lenses/skills`. */
    file: string;
    /** The extras that corrects it, under `review/lens-extras`, named in the failure line. */
    extras: string;
    /** What that file quotes of this one, one fragment per correction it makes. */
    quotes: string[];
}

const CORRECTIONS: Correction[] = [
    {
        file: "copilot-sql-code-review/SKILL.md",
        extras: "review/lens-extras/copilot-sql-code-review.md",
        quotes: [
            // The DISTINCT example, whose two queries do not return the same rows.
            "SELECT DISTINCT u.*",
            // The same example's BAD query, whose products join excludes rows the GOOD query
            // includes.
            "FROM users u, orders o, products p",
            // The same example's GOOD query. That it also drops the products join stays
            // unbound: an absence no fragment can carry.
            "SELECT u.id, u.name, u.email",
            // The "Overuse of DISTINCT" rewrite, which deduplicates at the same cost.
            "GROUP BY u.name",
            // The N+1 replacement, which reads every user and every order.
            "SELECT u.*, o.*",
            // The "SECURE" example's projection, SELECT * on the table the same skill uses to
            // illustrate sensitive columns.
            "SELECT * FROM users WHERE id = ?",
            // The "SECURE" parameterisation, which is MySQL's syntax labelled as PostgreSQL's.
            "PREPARE stmt FROM",
            // The "Function Misuse in WHERE Clauses" replacement. Stops before the trailing
            // space both lines end in, which is invisible to a reader and to any pass that
            // trims it.
            "GOOD: Range conditions use indexes\nSELECT * FROM orders",
            // The columnstore statement, which does not parse in T-SQL.
            "CREATE COLUMNSTORE INDEX idx_sales_cs ON sales",
            // The formatting example's LEFT JOIN, filtered in the WHERE clause. The defect is
            // that pairing, so the fragment spans both: either fix in the extras (writing
            // INNER JOIN, or moving the predicate into the ON clause) breaks it.
            "LEFT JOIN orders o ON u.id = o.user_id\nWHERE u.status = 'active'",
            // The checklist line the corrections above go the other way on.
            "Subqueries are optimized or converted to JOINs",
            // The join order bullet, which the extras narrows to the few cases where the
            // order the clauses are written in decides anything. Carried to the line below,
            // so that a qualification appended upstream breaks it; the bullet alone would
            // still match with the correction half-answered.
            "- **Join Order**: Optimize for smaller result sets first\n- **Cartesian Products**:",
            // The MySQL sessions table. Carried through to the closing line so that an index
            // added to the table breaks it; the column line alone would survive the addition
            // the correction asks for.
            "    expires TIMESTAMP\n) ENGINE=InnoDB;",
            // The PostgreSQL array table. Spans the whole body for the same reason: a key, a
            // constraint or a REFERENCES clause has to land inside these lines.
            "    post_id INT,\n    tag_names TEXT[]\n);",
        ],
    },
    {
        file: "copilot-web-design-reviewer/SKILL.md",
        extras: "review/lens-extras/copilot-web-design-reviewer.md",
        // The extras takes this skill's workflow apart step by step, so the step headings are
        // what its instructions rest on: renumber one upstream and the brief skips a step that
        // is still there while keeping one that has moved.
        quotes: [
            "### 1.1 URL Confirmation",
            "### 1.2 Understanding Project Structure",
            "### 1.3 Automatic Project Detection",
            "### 1.4 Identifying Styling Method",
            "## Step 2: Visual Inspection Phase",
            "### 2.3 Viewport Testing (Responsive)",
            "### 2.2 Inspection Items",
            "### 3.1 Issue Prioritization",
            "### 3.2 Identifying Source Files",
            "### 3.3 Applying Fixes",
            "## Step 4: Re-verification Phase",
            "| Issues Fixed |",
            "**Fixed File**",
        ],
    },
    {
        // The extras sends the lens here for the checks Step 2.2 only summarises. Nothing in
        // the skill links to this file, so nothing else would notice it going.
        file: "copilot-web-design-reviewer/references/visual-checklist.md",
        extras: "review/lens-extras/copilot-web-design-reviewer.md",
        quotes: [
            "## 2. Typography Verification",
            "### Color Consistency",
            "### Text Handling",
            "### Fonts",
            "### Buttons",
            "### Links",
            "### Form Elements",
            "### Keyboard Navigation",
            "### Images",
            "### Motion",
            "## Priority Matrix",
            // The touch-target line, which gives 2.5.5's AAA figure where the extras names
            // 2.5.8's AA one. Carried to the line below: a qualification appended upstream
            // would leave the line itself matching.
            "- [ ] Touch targets are 44x44px or larger\n- [ ] Text is readable size",
            // The head of the mobile list, where the extras puts the viewport meta tag the
            // section itself never mentions. The correction is an absence, and this binds
            // only a bullet added at the top of the list; one added lower down leaves it
            // unbound.
            "### Mobile (~640px)\n\n- [ ] Content fits within screen width",
        ],
    },
    {
        file: "anthropic-accessibility-review/SKILL.md",
        extras: "review/lens-extras/anthropic-accessibility-review.md",
        quotes: [
            "### Color Contrast Check",
            "### Keyboard Navigation",
            "### Screen Reader",
            "| Element | Announced As | Issue |",
            "1. **Start with contrast and keyboard**",
            "## Testing Approach",
            "1. Automated scan",
            "2. Keyboard-only navigation",
            "3. Screen reader testing",
            "4. Color contrast verification",
            "5. Zoom to 200%",
            "5. Focus traps in modals",
            "6. Missing ARIA landmarks",
            "## WCAG 2.1 AA Quick Reference",
            "- **2.5.5** Touch target",
            // The extras rests on this list naming 3.2.1 and no 3.2.2, and a 3.2.2 item added
            // beside it would leave that claim wrong with the fragment still matching.
            "- **3.2.1** Predictable on focus",
        ],
    },
    {
        file: "vercel-next-best-practices/self-hosting.md",
        extras: "review/lens-extras/vercel-next-best-practices.md",
        quotes: [
            "node .next/standalone/server.js",
            "## Testing Cache Handler",
            "**Critical**: Test your cache handler",
            "## Pre-Deployment Checklist",
            "npm run build",
            "pm2 start ecosystem.config.js",
            "npx create-sst@latest",
            "npx @opennextjs/aws build",
        ],
    },
    {
        file: "vercel-next-best-practices/debug-tricks.md",
        extras: "review/lens-extras/vercel-next-best-practices.md",
        // One fragment per half, because the extras skips the file on the strength of both.
        quotes: ["/_next/mcp", "--debug-build-paths"],
    },
    {
        file: "vercel-next-best-practices/bundling.md",
        extras: "review/lens-extras/vercel-next-best-practices.md",
        quotes: ["## Bundle Analysis"],
    },
    {
        file: "vercel-next-best-practices/hydration-error.md",
        extras: "review/lens-extras/vercel-next-best-practices.md",
        quotes: ["## Debugging"],
    },
    {
        file: "vercel-next-best-practices/file-conventions.md",
        extras: "review/lens-extras/vercel-next-best-practices.md",
        quotes: ["npx @next/codemod@latest upgrade"],
    },
    {
        file: "vercel-next-best-practices/async-patterns.md",
        extras: "review/lens-extras/vercel-next-best-practices.md",
        quotes: ["npx @next/codemod@latest next-async-request-api ."],
    },
];

export async function checkLensCorrections(): Promise<Failures> {
    const list: Failures = [];
    let checked = 0;

    for (const { file, extras, quotes } of CORRECTIONS) {
        const path = `lenses/skills/${file}`;

        if (!existsSync(path)) {
            fail(list, extras, `corrects ${path}, which is not there`);
            continue;
        }

        // An entry with nothing to look for proves nothing and reads like one that passed,
        // which is the shape this file's own OK line is written against.
        if (quotes.length === 0) {
            fail(list, extras, `binds no quotation to ${path}, so a re-vendor could strand its corrections`);
            continue;
        }

        const text = await Bun.file(path).text();

        for (const quote of quotes) {
            checked += 1;

            if (!text.includes(quote)) {
                fail(list, extras, `quotes \`${quote}\`, which ${path} no longer has`);
            }
        }
    }

    if (list.length === 0) {
        console.log(`OK lens-extras: ${checked} quotation(s) still in the skills they correct`);
    }

    return list;
}
