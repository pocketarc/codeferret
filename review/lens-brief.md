Review this change.

The repository is the current working directory. The instruction that follows names the
diff under review and the ref it is taken against. Run the commands in it as written.
Their pathspec excludes generated files such as lockfiles and build output, which are not
worth review.

The base ref is already decided. You are a subagent, so there is nobody to answer a
question — do not ask one.

__SKILL_LINE__

Every finding goes through the JSON below, whatever presentation the skill describes. A
finding you only write as prose is a finding nobody receives.

Be exhaustive. Read every changed file end to end and follow the data. Nothing
downstream catches what you miss.

Report, do not repair. Other lenses are reading the same working tree at the same time,
so changing a file corrupts their review as well as this one. Say what the fix is; do
not apply it.

Return JSON matching this schema as your entire final message:

__SCHEMA__
