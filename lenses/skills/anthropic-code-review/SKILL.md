---
name: anthropic-code-review
description: "CodeFerret review lens anthropic-code-review. A CodeFerret lens agent loads this during a multi-lens code review; it is not a general-purpose skill and is no use outside one."
---

# /code-review


Review code changes with a structured lens on security, performance, correctness, and maintainability.

## Usage

```
/code-review <PR URL or file path>
```

Review the provided code changes: the diff under review

If no specific file or URL is provided, ask what to review.

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                      CODE REVIEW                                   │
├─────────────────────────────────────────────────────────────────┤
│  STANDALONE (always works)                                       │
│  ✓ Paste a diff, PR URL, or point to files                      │
│  ✓ Security audit (OWASP top 10, injection, auth)               │
│  ✓ Performance review (N+1, memory leaks, complexity)           │
│  ✓ Correctness (edge cases, error handling, race conditions)    │
│  ✓ Style (naming, structure, readability)                        │
│  ✓ Actionable suggestions with code examples                    │
├─────────────────────────────────────────────────────────────────┤
│  SUPERCHARGED (when you connect your tools)                      │
│  + Source control: Pull PR diff automatically                    │
│  + Project tracker: Link findings to tickets                     │
│  + Knowledge base: Check against team coding standards           │
└─────────────────────────────────────────────────────────────────┘
```

## Review Dimensions

### Security
- SQL injection, XSS, CSRF
- Authentication and authorization flaws
- Secrets or credentials in code
- Insecure deserialization
- Path traversal
- SSRF

### Performance
- N+1 queries
- Unnecessary memory allocations
- Algorithmic complexity (O(n²) in hot paths)
- Missing database indexes
- Unbounded queries or loops
- Resource leaks

### Correctness
- Edge cases (empty input, null, overflow)
- Race conditions and concurrency issues
- Error handling and propagation
- Off-by-one errors
- Type safety

### Maintainability
- Naming clarity
- Single responsibility
- Duplication
- Test coverage
- Documentation for non-obvious logic

## Output

```markdown
## Code Review: [PR title or file]

### Summary
[1-2 sentence overview of the changes and overall quality]

### Critical Issues
| # | File | Line | Issue | Severity |
|---|------|------|-------|----------|
| 1 | [file] | [line] | [description] | 🔴 Critical |

### Suggestions
| # | File | Line | Suggestion | Category |
|---|------|------|------------|----------|
| 1 | [file] | [line] | [description] | Performance |

### What Looks Good
- [Positive observations]

### Verdict
[Approve / Request Changes / Needs Discussion]
```

## Tips

1. **Provide context** — "This is a hot path" or "This handles PII" helps me focus.
2. **Specify concerns** — "Focus on security" narrows the review.
3. **Include tests** — I'll check test coverage and quality too.
