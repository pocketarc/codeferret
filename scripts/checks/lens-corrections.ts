/**
 * That every correction in `review/lens-extras/` still quotes text the vendored skill has.
 *
 * A lens loads the vendored skill and the extras together, and the extras corrects the skill
 * by quoting it: this example returns different rows, that statement does not parse, this
 * checklist line holds for one case of two. The skill is pinned in
 * `lenses/skills/PROVENANCE.tsv`, and nothing tied a quotation to the pin. Re-vendor at a
 * commit where upstream has fixed one of them, and the correction goes on telling the lens
 * that the skill says something it no longer says.
 *
 * A stale correction is not a harmless one. It is a second, contradictory instruction about
 * SQL that the lens carries into every review, and nothing fails.
 *
 * `checkSkillFences` is the same shape of problem already solved once: a deliberate edit to a
 * vendored file that a re-vendor would otherwise drop in silence. This is the larger deliberate
 * edit to the same pinned material.
 *
 * One fragment per correction, chosen to sit on one line of the vendored file, because the
 * extras reflows its quotations across lines and a whole-paragraph match would fail on the
 * wrapping alone. What each fragment stands for is the paragraph that quotes it, so add a
 * line here whenever you add a correction to an extras file.
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
            // The "Overuse of DISTINCT" rewrite, which deduplicates at the same cost.
            "GROUP BY u.name",
            // The N+1 replacement, which reads every user and every order.
            "SELECT u.*, o.*",
            // The "SECURE" example's projection, SELECT * on the table the same skill uses to
            // illustrate sensitive columns.
            "SELECT * FROM users WHERE id = ?",
            // The "SECURE" parameterisation, which is MySQL's syntax labelled as PostgreSQL's.
            "PREPARE stmt FROM",
            // The "Function Misuse in WHERE Clauses" replacement, which keeps SELECT * on orders.
            "SELECT * FROM orders ",
            // The columnstore statement, which does not parse in T-SQL.
            "CREATE COLUMNSTORE INDEX idx_sales_cs ON sales",
            // The formatting example's LEFT JOIN, filtered in the WHERE clause.
            "  AND o.order_date >= '2024-01-01';",
            // The checklist line the corrections above go the other way on.
            "Subqueries are optimized or converted to JOINs",
            // The MySQL sessions table, with no index on the column its sweep query filters.
            "    expires TIMESTAMP",
            // The PostgreSQL array table, with no key and no foreign key to posts.
            "    tag_names TEXT[]",
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
        ],
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
