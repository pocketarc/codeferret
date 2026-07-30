Review this pull request.

The repository is the current working directory. The diff under review is:

    git diff __BASE__...HEAD
    git log __BASE__..HEAD --oneline

The fixed point is `__BASE__`. It is already decided. You are running headless, so
there is nobody to answer a question — do not ask one.

Load the `__SKILL__` skill and have at it.

Every finding goes through the JSON below, whatever presentation the skill
describes. A finding you only write as prose is a finding nobody receives.

Be exhaustive. Read every changed file end to end and follow the data. Nothing
downstream catches what you miss.

Report, do not repair. Other lenses are reading the same working tree at the same time,
so changing a file corrupts their review as well as this one. Say what the fix is; do
not apply it.

Return JSON matching this schema as your entire final message:

__SCHEMA__
