---
name: code-review
description: Review code for quality, bugs, and best practices
tags: development
---

# Code Review Guidelines

When reviewing code, follow these steps:

1. **Read the code thoroughly** — understand the intent before critiquing.
2. **Check for bugs** — null references, off-by-one errors, race conditions, resource leaks.
3. **Evaluate naming** — are variables, functions, and classes named clearly?
4. **Assess structure** — is the code modular? Are responsibilities well-separated?
5. **Security** — look for injection vulnerabilities, unsafe inputs, hardcoded secrets.
6. **Performance** — unnecessary allocations, N+1 queries, blocking calls in async code.
7. **Tests** — are edge cases covered? Are tests readable and maintainable?

Output format:
- Start with a one-line summary (good / needs work / has issues).
- List findings grouped by severity: 🔴 Critical, 🟡 Warning, 🟢 Suggestion.
- For each finding, include file, line, and a concrete fix.
