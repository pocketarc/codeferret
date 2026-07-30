---
name: writing-review
description: Review and improve any written output. Detect and remove AI writing tropes in prose (blog posts, articles, READMEs, emails, commit messages, PR descriptions, code comments) and in the progress narration an agent writes between tool calls, and apply Simplified Technical English to procedural and reference documentation (install steps, runbooks, API reference, CLI help, error messages, troubleshooting guides). Use proactively whenever writing, reviewing, or rewriting text. Also use when asked to check for AI writing patterns, humanize text, or make instructions clearer. Do NOT use for pure code output (code comments are prose and count).
---

# Writing Review

Avoid patterns that signal AI-generated text, and write technical documentation that a tired reader can follow on the first pass.

## Reviewing a diff

The prose a change ships is in scope: documentation and README files, docstrings, code
comments, user-facing copy, error and log messages, and the commit messages in the range.
Identifiers, test fixtures, and sample data are not.

Report each violation as a finding on the line that carries it. One finding per passage,
naming the rule it breaks and what the passage leaves vague. Where a rule is a
substitution, the substitution is the finding: "utilize" is reported as "use". Do not
rewrite a paragraph. An author who asked for a review did not ask for a ghostwriter.

Density is the tell, so a single instance of a pattern usually passes. Report the third
tricolon, not the first.

Whether a comment should exist at all is a separate question, and not this lens's.

## Choose the register first

This skill holds two rule sets. They contradict each other in places, deliberately, because they serve different readers.

**Prose.** Blog posts, articles, devlog entries, notes, landing page copy, emails, commit messages, PR descriptions, code comments, README introductions. Use the rules in this file.

**Technical documentation.** Install and setup steps, runbooks, API and configuration reference, CLI help text, error messages, troubleshooting guides, migration instructions. Read `references/technical-writing.md` now, before writing or reviewing anything, and apply those rules instead of the ones below.

**Progress narration.** The commentary an agent writes between tool calls. Use the prose rules plus the "Progress narration" section near the end of this file.

A single document often needs both. A README with a voice-driven intro and an install section should switch register at the section boundary rather than picking one for the whole file.

Where the two conflict, the register decides. Never flag technical documentation for being repetitive, monotone, or voiceless: that is the intended output. Never apply word limits or vocabulary restrictions to prose.

## Fix the substance, not the tokens

The patterns below are symptoms. The underlying problems are vagueness, puffery, unverifiable claims, and padding. Swapping banned words for synonyms while leaving the empty claim in place makes the writing harder to diagnose without making it better.

So: when a rule says to remove a phrase, the fix is usually to state the specific fact the phrase was standing in for, or to cut the sentence. It is rarely to reach for a different word.

Two corollaries:

- A word being overused by AI does not mean its synonyms are. These lists are literal. Do not expand them to near-synonyms and strip those too.
- One instance of a pattern is usually fine. Density is the tell. A single tricolon is elegant; three in a row is a failure.

## Modes

**Reviewing existing text.** Report findings as a concrete list: line number, the trope violated, and a suggested fix. Group by severity, with content duplication and structural issues first and word-level nits last.

**Writing new text.** After drafting, review your own output against the rules below before presenting it. Prefer simple verbs over pompous ones, specific facts over vague significance claims, one statement of a point over two reworded versions, and straight quotes over curly ones.

**Rewriting a draft.** Preserve the meaning and the author's register. If the user supplies a sample of their own writing, read it first and match its sentence-length pattern, vocabulary level, punctuation habits, and transition style, then replace AI patterns with patterns from the sample. When you are done, ask yourself "what still makes this read as AI-generated?", answer briefly, and revise once more.

Clean but voiceless is also a failure state. Prose where every sentence is the same length, nobody has an opinion, and no uncertainty is ever admitted reads as machine-made even with zero banned words in it. Vary the rhythm, take a position, and let complexity stay complex.

## Word-level

- Replace "serves as", "stands as", "marks", "represents", "functions as", "operates as", "holds the distinction of being", "refers to" with "is" or "are".
- Don't dodge a copula with a biography verb: "began his career as", "ventured into politics as a candidate". Use "was".
- Remove "delve", "utilize", "leverage" (as verb), "robust", "streamline", "harness". Use plain verbs.
- Remove "quietly", "deeply", "fundamentally", "remarkably", "arguably". Be specific instead.
- Replace abstract uses of "tapestry", "landscape", "paradigm", "synergy", "ecosystem" with concrete nouns.
- Remove "certainly", "additionally" (especially sentence-initial), "importantly", "interestingly", "notably".
- Replace "boasts" (meaning "has"), "features", "offers", "showcases", "featuring" with "has", "includes", or "with".
- Remove "vibrant", "rich" (as vague praise), "nestled", "in the heart of", "groundbreaking", "renowned", "pivotal", "crucial", "vital", "meticulous/meticulously", "testament", "enduring", "intricate/intricacies", "fostering", "garner", "underscore" (figurative), "bolstered", "exemplifies", "commitment to", "diverse array", "profound", "enhancing", "emphasizing", "align/resonate with".
- Remove "key" as a vague adjective ("a key factor", "key challenges"). Use "main" or nothing.
- Remove "load bearing" / "load-bearing" ("this assumption is load-bearing", "doing a lot of load-bearing work"). Say what the thing actually does or why it matters.
- Remove "belt and braces" / "belt-and-braces" ("a belt-and-braces approach", "belt-and-braces safety check"). Say what the two safeguards actually are, or drop the idiom.
- Remove "gated" ("the rollout is gated", "gated behind a check"). Say what does the gating and under what condition.
- Remove "valuable" ("valuable insights", "valuable resource"). Say what the value actually is, or drop it.
- Remove "interplay". Use "relationship", "connection", or describe the specific interaction.
- Remove "encompassing". Use "including" or say what is actually included.
- Remove "cultivating". Use "building", "creating", or a more specific verb.
- Remove "hailed from". Use "was from" or "came from".
- Remove "esteemed", "distinguished", "prominent", "noted" before people or institutions. Remove the adjective or replace with a specific credential.
- Replace "plays a role in" / "played a pivotal role in" with what the subject actually did.
- Replace "a [adjective] fusion/blend of" with "combines" or "mixes", or just describe what is combined.
- Don't use elegant variation. If you said "integration" in the previous sentence, say "integration" again, not "the system", "the connector", or "the platform". Repeating a word is better than reaching for a synonym that muddies meaning.

## Sentence patterns

- Remove "It's not X, it's Y" and all negative parallelism variants ("not because X, but because Y", "The question isn't X. The question is Y.").
- Remove the reversed form too: "prioritizing X rather than Y", "chose consolidation over ideology". Same trick, inverted.
- Remove "Not X. Not Y. Just Z." dramatic countdowns.
- Remove tailing negation fragments bolted onto the end of a sentence: "The options come from the selected item, no guessing." Write it as a real clause.
- Remove "The X? A Y." Self-posed rhetorical questions answered immediately.
- Remove anaphora: don't start 3+ consecutive sentences/clauses with the same word.
- Limit tricolons (groups of three) to one per section. Never stack multiple tricolons back to back.
- Remove "It's worth noting", "It bears mentioning", "it's important to note", "it's crucial to remember", and all filler transitions that introduce a point without connecting it.
- Remove trailing present-participle phrases that inject shallow analysis ("highlighting its importance", "reflecting broader trends", "contributing to the development of...", "underscoring its role as...", "ensuring a sustainable future", "symbolizing its ongoing...").
- Remove "from X to Y" false ranges where X and Y aren't on a real spectrum.
- Remove "not just X, but also Y" constructions that frame ordinary descriptions as surprising revelations.
- Don't drop the subject to sound punchy: "No configuration file needed", "Results preserved automatically". Name who does what, or use the passive if there is no actor (see "False agency" below before reaching for the active voice).
- Keep the conjunction "that" when the noun after the verb could be misread as its object. "Check that the hook still works", not "Check the hook still works": "check the hook" is a valid parse, so the reader commits to it and then has to back up when "still works" arrives. Drop "that" freely where no misreading is possible ("I think it's fine"). This is GR-1 in `references/technical-writing.md`, and unlike the rest of that file you apply it in prose too.
- Don't overclaim. One run is evidence, not proof. Write "to check that the hook still works", not "to prove the hook survives". Same for "confirms", "guarantees", and "verifies" attached to a single observation.
- Don't stack hedges ("could potentially possibly be argued that it might"). One hedge, or none.
- Don't exaggerate source quantity ("several publications have noted", "widely recognized", "multiple experts agree") when only one or two sources exist. Match attribution to actual count, or name them.
- Remove "continues to evolve", "ongoing efforts", "remains relevant" and similar vague temporal hedges. Replace with a specific fact or date, or remove.

## False agency

Models give agency to things that can't have any. This is the strongest tell in the file and it is never acceptable. Treat every instance as a defect: the ones that sound fine, the ones that are idiomatic, the ones you can point to in published human writing. Don't exempt an instance because it's conventional, and don't exempt one because the sentence is short. In review, rank these with the structural findings, not the word-level nits.

### What it's called

Learn the names below. Without them you will catch the obvious cases and miss the rest.

- Personification, or prosopopoeia in classical rhetoric. An inanimate thing performs a human action.
- Anthropomorphism. What the Google and Microsoft developer style guides call it when they ban it for software.
- Inanimate agency. The syntax underneath: a non-actor sitting in the subject slot of an agentive verb.
- The intentional stance, after Dennett. Describing a system as though it holds beliefs, desires, and permissions, because that's cheaper than describing its mechanism. This is where "the parser wants a closing brace" and "the linter is happy" come from.
- Grammatical metaphor, after Halliday. A process is repackaged as a thing so it can be passed around as an object. In "inviting the edit", a future act of writing has become a party favour for a document to hand out.

### Why it happens

"Active voice good, passive voice bad" is fair advice for a formal essay and bad advice everywhere else. You can't write an active clause without a subject. So when the real actor is absent, or is you, you conscript an abstraction to fill the slot rather than admit that a person made a choice. That's the whole mechanism, and it's why the fix is almost always to name yourself or to use the passive.

### The verb families

Watch all of these, not just the family you checked for last time.

- Volition and cognition: wants, needs, expects, knows, thinks, believes, assumes, decides, prefers, cares, tries, is happy, is confused, complains.
- Permission and prohibition: allows, permits, lets, forbids, prohibits, requires, demands, invites, encourages, discourages, insists, refuses, enforces. Writers reach for these hardest when the subject is a rule, a spec, a config, or a linter.
- Speech acts: says, tells, argues, claims, suggests, warns, notes, mentions, admits, promises, explains.
- Physical action and motion: rides, chases, drives, pushes, drops, reaches for, hands off, moves out, owns, guards, fights, breaks free.
- Aesthetic reaction: reads badly, feels awkward, looks confused, wants to be shorter. The sentence doesn't read. You do.

### The middle voice

A transitive verb used intransitively, with the thing acted on sitting in the subject slot, and the actor gone. "Compose validates" (a tool validated the file). "The migration applies clean" (you applied it). "This reads badly" (you read it). "The patch reviews well" (a reviewer read it).

Not every intransitive is this. "The door opened", "the build broke", "the tests pass", and "the process exited" describe things that genuinely happen with no external actor in view. The tell is that you can name the actor and you've left them out.

Fix it by stating the property or naming the actor. "Compose validates" becomes "the compose file is valid", or "`docker compose config` exits clean" when the evidence matters more than the fact.

### The stacked form

In the worst version you nest one false agent inside another, so that a sentence about a human decision ends up with no human in it. In "Stop the reviewer briefing from inviting the edit 0003 forbids" there is a briefing that invites, a rule that forbids, and a writing act converted into a noun so the briefing has something to offer. Three layers, zero people, and the person who made the change is the one typing the sentence.

Two syntactic tells for the stacked form: a relative clause attached to an abstract object, and a "stop X from V-ing" or "prevent X from V-ing" frame where X isn't a person.

### The test

Ask who did it, then:

- A person did it. Name the person. "I removed the suggestion", not "the briefing stopped suggesting it".
- A tool did it. Name the tool and use its real mechanism. The query optimiser uses the index; the lateral join doesn't ride it. A job runs on the queue; it doesn't ride the queue.
- A written rule is involved. Name the requirement, don't deputise the document. "Rule 0003 forbids X" becomes "X violates rule 0003", or "we don't do X, per rule 0003". A rule is a thing you measure against, not an enforcer.
- Nobody did it. Use the passive. "The adoption code was moved out", not "adoption moved out". The passive is correct here, and forcing the active voice is what produced the tic.
- None of the four fit. Then you're hiding a decision. Find it and write that instead.

Don't turn a process into a state either. Hunks of code get blended; they are not "clear blends". Say what you did to them.

### Not a defence

Reject all of these. Don't make them in prose, and don't accept them in a review reply.

- "It's a dead metaphor, nobody reads it literally." Irrelevant. Writers talk themselves into the live kind by way of the dead kind.
- "Lawyers and standards bodies write this way." That's a genre convention you aren't writing in. Even there, "the statute prohibits" is shorthand for what a legislature decided.
- "Every style guide does it." So does every model. That's the problem.
- "The paraphrase is longer." Then it's longer. Brevity bought by deleting the actor isn't brevity, it's a missing fact.
- "The actor is obvious from context." If it's obvious, naming it costs one word. If it isn't, you just hid it.

### Rewrite recipes

- "X allows you to Y" becomes "Use X to Y", or "You can Y with X".
- "The config wants an absolute path" becomes "The config must be an absolute path", or "The loader rejects relative paths".
- "The test suite is unhappy" becomes "Three tests fail".
- "The migration decided to skip the column" becomes "The migration skipped the column because ...".
- "This design invites misuse" becomes "Callers will do X, which breaks Y".
- "The docs say to run it twice" becomes "Run it twice (see docs/setup.md)".

## Technical precision

- Don't clip an established term of art. It's a lateral join, not "a lateral". Practitioners keep the head noun; models drop it.
- Use the verb the domain actually uses. A query took 19 seconds. It didn't "hit" 19 seconds. Reaching for the punchier verb is the tell.

### Precision and naturalness

The two rules above are about reaching for the domain's vocabulary. This one is about where to stop, because narrower is not the same as more accurate.

Prefer the natural word over the narrower one when any of these hold:

- The narrower word claims knowledge you don't have. "Check that the hook still fires" asserts that the failure mode you're testing for is a trigger failure. You don't know that yet, which is the whole reason you're running the check. "Still works" matches what you actually know, which makes it the more accurate word, not the less accurate one. False precision is a correctness bug, not a style preference.
- The distinction wouldn't change what the reader does. A reader stops on a narrow term to work out why you picked it and what they should now be tracking. If there's no distinction behind it, you've spent their attention for nothing.
- A practitioner wouldn't say it out loud. "Does the hook still work" is what someone says at a terminal. "Does the hook still fire" is a phrase lifted off a spec. This is also what separates this rule from the two above: clipping "lateral join" to "a lateral" produces something nobody says, while choosing "works" over "fires" produces something everybody says. The test is the practitioner's mouth, not the narrower word.

This is not a licence to be vague. To check yourself, name the distinction you dropped. "Works" instead of "fires" drops the trigger-versus-behaviour distinction, and you dropped it on purpose because you're testing both. "It's broken" instead of "three tests fail" drops nothing you can name, because there was no distinction there, only a fact you withheld. The first is a choice of grain. The second is vagueness, and calling it natural doesn't change that.

In technical documentation, always take the precise term. The STE rules already require one term per concept held constant throughout, so apply this section to prose and progress narration only.

## Paragraph structure

- Don't use short sentence fragments as standalone paragraphs for manufactured emphasis.
- Don't follow a heading with a one-line restatement of the heading before the real content starts. Cut the warm-up sentence.
- Don't disguise lists as prose ("The first... The second... The third..."). Use an actual list or write real paragraphs.
- Don't create sections that exist solely to assert importance or recognition ("Media Coverage", "Awards and Recognition", "Legacy and Impact") unless they contain substantive content. Fold real facts into the body.
- Don't create formulaic "Challenges and Future Directions/Outlook" sections. Discuss challenges where they're relevant, not in a sandwiched-between-praise section at the end.

## Tone

- Remove "Here's the kicker", "Here's the thing", "Here's where it gets interesting", "Here's what most people miss".
- Remove "Think of it as...", "It's like a...". Don't reach for metaphors to explain things that are already clear.
- Remove "Imagine a world where..."
- Remove "The truth is simple", "The reality is...", "History is clear". If the point is clear, it doesn't need this preamble.
- Remove false-depth framing: "The real question is", "the real test", "the real problem", "the real issue", "the real work", "at its core", "in reality", "what really matters", "the deeper issue", "the heart of the matter". These promise to cut through noise and then restate an ordinary point. "The real X" costs you twice in a progress update, because you also demote the check you just ran to a fake one.
- Remove "the honest X": "the honest answer", "the honest version", "the honest assessment", "the honest take". Labelling one statement as the honest one implies the others weren't. Just say the thing.
- Remove "Let's break this down", "Let's unpack this", "Let's explore", "Let's dive in", "here's what you need to know", "without further ado".
- Remove "Of course!", "Certainly!", "Great question!", "You're absolutely right" and other sycophantic openers.
- Don't inflate stakes ("fundamentally reshape", "define the next era", "something entirely new").
- Don't end on a generic upbeat note ("the future looks bright", "exciting times ahead", "a major step in the right direction"). End on a fact or stop.
- Don't attribute claims to unnamed authorities ("Experts argue", "Industry reports suggest", "Observers have cited"). Name the source or drop the claim.
- Don't invent compound concept labels ("the supervision paradox", "the acceleration trap", "workload creep") and use them as if they're established terms.
- Remove false vulnerability ("And yes, I'm openly...", "This is not a rant; it's a diagnosis").
- Remove "Despite its challenges..." formula. Don't acknowledge problems only to immediately dismiss them. Also covers the inverse: "Despite its [success], [subject] faces challenges..."
- Don't write in travel-guide voice ("offers visitors a fascinating glimpse", "captivates residents and visitors alike", "scenic landscapes"). Use specific, factual descriptions.
- Don't write in press-release voice ("CEO X emphasized the company's commitment to Y"). Quote the actual statement with a citation, or remove.
- Replace "a [adjective] hub of [noun]" ("a dynamic hub of activity and culture") with a concrete description.
- Don't claim a subject "maintains an active social media presence" or "has a strong digital presence" without specific facts.
- Don't speculate about absence ("keeps a low profile", "details are not publicly documented"). Not finding something is not evidence that it's private.

## Formatting

- Remove all em dashes. Rewrite with commas, parentheses, colons, or separate sentences. Substituting a spaced en dash or a spaced hyphen is the same tell wearing a hat.
- Don't use bold-first bullets ("**Security:** Environment-based..."). Use plain bullets, or a table when there are genuinely two columns of data.
- Don't build a two-row table for facts that belong in a sentence.
- Don't overuse boldface in general. Don't bold every key term or phrase in a paragraph.
- Use straight quotes and apostrophes everywhere, never curly/smart quotes. Use `->` not unicode arrows.
- Don't decorate headings or bullets with emoji.
- Use sentence case in headings, not Title Case.
- Don't skip heading levels (an h1 followed by an h3).
- Don't insert thematic breaks (`---`, `***`) before every heading.
- Strip chatbot markup that survives a copy-paste: `turn0search0`, `:contentReference[oaicite:0]{index=0}`, `[cite: 1]`, `【85†L261-269】`, `[attached_file:1]`, `:::writing{variant="document"}`, and `?utm_source=chatgpt.com` appended to URLs.

## Composition

- Say it once. Don't restate the same point in different words across multiple sentences or sections.
- Don't summarise what you just said ("As we've seen in this section..."). The reader just read it.
- Don't signpost conclusions ("In conclusion", "To sum up", "In summary", "Overall, ..."). Just conclude.
- Use a metaphor once, then move on. Don't repeat the same metaphor across multiple paragraphs.
- Don't stack historical analogies ("Apple didn't build Uber. Facebook didn't build Spotify. Stripe didn't build...").
- Don't add sections about significance, legacy, or "broader trends" unless the content genuinely warrants it.
- Remove "so you can focus on..." and similar marketing constructions.
- Don't add significance/legacy/impact statements to mundane facts ("marking a pivotal moment in the evolution of...", "setting the stage for...").
- Remove assistant language: "I hope this helps", "Would you like...", "Let me know if...", "Is there anything else...".
- Remove hedging about limited information: "While specific details are limited...", "based on available information", "not widely documented".
- Cut genuine bloat: "at this point in time" (now), "in the event that" (if), "has the ability to" (can).
- Maintain a consistent register throughout a document. Don't swing between casual and stiff/formal.

## Commit messages, PR descriptions, and review replies

These have their own tells, and they are strong ones.

- Don't mention what you didn't change. "while preserving the existing behaviour", "retaining the current API", "without altering the public interface". Nobody writes this by hand; it is an LLM reciting its own instructions back.
- Don't assure the reader that the work meets a standard. "improved clarity, flow and readability", "ensures compliance with the style guide", "refined tone for consistency". Say what changed instead.
- Don't emphasise that evidence exists rather than what it says. "added sourced content", "improved test coverage", "strengthened attribution". Name what is now covered or cited.
- Don't stack several of these vague improvements in one summary. The stacking is the giveaway.
- Don't write a formal first-person paragraph where a terse line is the convention.
- Don't give the diff, the file, or the rule agency. There are three false agents in "Stop the reviewer briefing from inviting the edit 0003 forbids". Write what you did instead: "Remove the briefing's suggestion that violates rule 0003." A commit message is a record of what a person changed, so this register has the least excuse of any. See "False agency".

## Progress narration

The running commentary between tool calls is writing too, and it is the highest-volume writing an agent produces. Apply the prose rules, plus these.

- Don't beat a drum before the next step. "Now the real test", "Here's where it gets interesting", "The moment of truth". Say what you are about to do and do it.
- Don't restate tool output as though the tool held an opinion. A 0 exit from `docker compose config` is evidence that the file is valid. It is not grounds for writing "Compose validates". See "The middle voice".
- Don't use a subjectless participial fragment for the next step. "Starting MySQL, then editing backup.sh" becomes "Next I'll start MySQL, then edit backup.sh". You are the actor, so say so.
- Don't declare success before the evidence is in. "Fixed" goes after the test passes, not after the edit.
- Report a failure in the same register as a success. If three tests still fail, write that as short and as plain as you would have written the line saying they passed. No cushioning, no preamble, no explaining why it doesn't really count.
- Don't narrate what you are about to do and then narrate it again after doing it. Once is enough, and after is usually the more useful of the two.

## What human writing looks like

These are all more common in human writing than in AI output. Do not "fix" them, and do not flag them in review.

- Simple copulas and possession: "there is a", "it has a".
- Plain verbs over stiff synonyms: wrote (not authored), moved (not relocated), used (not utilised), tried (not attempted), died (not passed away), started (not commenced).
- Superlative and definitive statements when they're true: "one of the best", "is the only", "was the first".
- Hedging qualifiers and intensifiers: "very", "perhaps", "tends to".
- Mildly wordy constructions: "as a result of", "in order to", "all of the", "a part of", "the fact that". These read as human. Stripping them mechanically makes the text look more AI, not less.

## Don't over-correct

None of these is evidence of AI writing on its own. Don't flag them:

- Perfect grammar. Plenty of people write well.
- A mix of casual and formal register, or prose that is both clinical and emotional.
- Formal, academic, or "fancy" prose. The tell is specific overused words, not sophistication in general.
- Transition words in isolation. "Additionally" opening one sentence is a style choice, not a signature.
