# Technical writing

Rules for documentation that someone reads while trying to get something done, often in a hurry, often not in their first language.

Adapted from ASD-STE100 Simplified Technical English, Issue 8 (2021), a controlled-language standard maintained by the STEMG under ASD. It was built in the 1980s for aircraft maintenance manuals, where a misreading damages an aircraft. Rule numbers below cite the spec so they can be traced back.

Apply these rules instead of the prose rules in `SKILL.md`, not alongside them. This register produces uniform, repetitive, deliberately flat text. That is the goal, not a failure. Don't "fix" the output for lacking rhythm, variety, or personality.

## What carries over from the spec, and what doesn't

The spec has two parts: 53 writing rules and a controlled dictionary of roughly 900 approved words.

The rules carry over to software documentation almost unchanged. The dictionary does not: its approved words were chosen for aircraft maintenance, so writing about software against it means fighting it constantly. Skip the dictionary. Keep a project glossary instead and apply the same discipline: one term per concept, defined once, reused everywhere.

## Words

- Give each term one meaning and one part of speech, then hold it. If "job" means a queued unit of work, it never also means a cron entry. (Rules 1.2, 1.3)
- Never use two names for the same thing. Not "job", "task", and "work item" for one concept. Pick one and put it in the glossary. (Rule 1.11)
- Don't verb a noun or nominalise a verb. Write "initialise the store", not "do the initialisation of the store". (Rules 1.7, 1.13, 3.7)
- Don't use slang or in-house jargon as a name for something. (Rule 1.10)
- When you must coin a term, make it short and self-explaining. (Rule 1.9)

## Noun clusters

- Cap noun clusters at three words. Break longer ones with prepositions. (Rule 2.1)
- "User authentication token expiry policy" becomes "the expiry policy for user authentication tokens".
- "Database connection pool exhaustion error" becomes "the error raised when the database connection pool is exhausted".
- Articles and prepositions don't count towards the three. Keep them: dropping articles creates ambiguity. (Rules 2.1, 2.3)
- Write a long proper name out in full on first use, then define a short form and use that. (Rule 2.2)

## Verbs

- Use simple tenses only: infinitive, imperative, simple present, simple past, past participle as an adjective, and simple future. (Rule 3.2)
- No present perfect, past perfect, or progressive. "The migration has completed" becomes "The migration is complete". "The server is listening" becomes "The server listens". (Rules 3.2, 3.4)
- Don't stack helping verbs. "The timeout can be configured" becomes "You can configure the timeout". "The value must be set before startup" becomes "Set the value before startup". (Rule 3.4)
- Avoid "-ing" forms except inside an established name ("connection pooling", "rolling restart"). (Rule 3.5)
- Use the active voice in every instruction, without exception. (Rule 3.6)
- In descriptive text, prefer the active voice but use the passive when it keeps the technical content correct. Naming a false actor is worse than using the passive. "The adoption code was moved out" is right; "adoption moved out" is not. (Rule 3.6)
- Never give agency to a thing. No component wants, allows, forbids, knows, or decides anything. "The parser expects a closing brace" becomes "Add a closing brace". "The API allows you to filter" becomes "Use the filter parameter". Follow this rule in both registers. Apply the "False agency" section of `SKILL.md` here without modification: it is the one prose section you should.
- Don't build phrasal verbs when a single verb exists. "Spin up an instance" becomes "start an instance". "Tear down the stack" becomes "delete the stack". (Rule 9.3)

## Sentences

- One topic per sentence. In descriptive text, introduce the topic and then develop it across the sentences that follow. (Rules 4.1, 6.1)
- Never omit words to save space, and never use contractions. "If installed, remove the shims" becomes "If shims are installed, remove them". "Cannot be empty" becomes "The field cannot be empty". (Rule 4.2)
- Be concrete. "No leaks permitted" tells the reader nothing to do; "Make sure that there are no leaks" does. (Rule 4.1)
- Use a vertical list when a sentence carries more than one condition or item. (Rule 4.3)
- Connect related sentences with plain connectives: and, but, then, thus, as a result, at the same time. (Rules 4.4, 6.2)

## Procedures

- Maximum 20 words per sentence. (Rule 5.1)
- One instruction per sentence, unless two actions genuinely happen at once ("Hold the button and connect the cable"). (Rule 5.2)
- Write every instruction in the imperative. "Run the migration", not "The migration should be run" or "You will want to run the migration". (Rule 5.3)
- Number the steps. If a step has sub-steps, letter them. (Rule 5.2)
- When a step opens with a condition, put the condition first and separate it with a comma: "If the build fails, check the lockfile." (Rule 5.4)
- Notes give information only. Never hide a required action inside a note: if the reader must do it, it is a step. (Rule 5.5)

## Reference and descriptive text

- Maximum 25 words per sentence. (Rule 6.3)
- Give information gradually. Don't front-load a paragraph with everything at once. (Rule 6.1)
- One topic per paragraph. (Rule 6.5)
- Maximum six sentences per paragraph. Split anything longer. (Rule 6.6)
- Group related facts into the same paragraph rather than scattering them. (Rule 6.4)

## Warnings

The aerospace split is warning (risk to people) and caution (risk to equipment). The software equivalents are data loss, irreversibility, cost, and downtime.

- Label the severity so the reader can see it before reading the body. (Rule 7.1)
- Open with the command or the condition, not with background. (Rule 7.2)
- State the specific consequence. "Be careful with this command" is useless; "This deletes every row in every table and cannot be undone" is not. (Rule 7.3)
- Put the warning before the step it applies to, never after. (Section 5)
- Warnings obey the 20-word sentence limit too. (Rule 5.1)

## Punctuation and counting

- No semicolons. Use a full stop or a vertical list. (Rule 8.1)
- Hyphenate closely related words that act as one unit. (Rule 8.2)
- Use parentheses for cross-references, identifiers, abbreviations on first use, and short clarifications. (Rule 8.3)
- For word counts: a colon introducing a vertical list ends the sentence, and each list item counts as its own sentence against the limit. (Rule 8.4)
- Text in parentheses counts as one word. Numbers, units, abbreviations, alphanumeric identifiers, quoted text, and headings each count as one word. A code identifier is one word however long it is. (Rules 8.5, 8.6, 8.7)

## Consistency

Identical actions get identical wording, every single time. If step 2 says "Apply a small quantity of oil to the threads of the two bolts", then step 6 says the same thing about its bolts, word for word. (Rule 9.4)

This is the exact opposite of the prose rule against monotony, and it is correct here. The reader recognises a repeated instruction at a glance and stops parsing. Variation forces them to re-read to check whether something different is being asked.

The same applies to component names, section titles, and error text.

## General recommendations

These are advisory in the spec rather than rules.

- Keep the conjunction "that". Write "Make sure that the valve is open", not "Make sure the valve is open". It marks where the main clause ends and helps translation. (GR-1)
- Re-read any sentence containing "with". "Install the panel with the green fasteners" has three possible meanings. Rewrite as "Use the green fasteners to install the panel". (GR-2)
- Make every pronoun's referent unambiguous. (GR-3)
- Follow "this" with a noun: "this timeout", not a bare "this". (GR-4)
- Watch for false friends, words that resemble a word in the reader's language but mean something else. (GR-5)
- Write Latin abbreviations out: "for example" rather than "e.g.", "that is" rather than "i.e." (GR-6)

## Deliberate deviations

- **Spelling.** Rule 1.14 mandates American English, which matches Bruno's own writing. Follow the surrounding project if it differs.
- **Em dashes.** The spec permits them and bans only semicolons. Keep the em dash ban from `SKILL.md` anyway: it reads as an AI tell in any register.
- **Dictionary.** Not adopted, per the note above. Use a project glossary.

## Source

ASD-STE100 Issue 8, 2021-04-30. The full spec sits next to this file at `asd-ste100-issue-8.pdf` (424 pages: writing rules in Part 1, dictionary in Part 2). Each section of Part 1 opens with a summary box listing its rules, which is the fastest way in.

Issue 9 was released 2025-01-15 and is the current version; the rules are stable between issues, and the dictionary is where most changes land. Free copies are available on request from asd-ste100.org. This file paraphrases the rules rather than reproducing them.
