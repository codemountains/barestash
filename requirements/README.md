# requirements

`requirements/` holds product requirements, acceptance criteria, scope, priorities, and open questions.

## Ownership

- Product behavior and in/out of scope live here.
- Infrastructure (technical design, operations, topology, runbooks, etc.) lives in [`../docs/`](../docs/).

## Documents

| File | Description |
| --- | --- |
| [`barestash.spec.md`](barestash.spec.md) | Barestash product concept, positioning, use cases, design principles, and MVP scope |
| [`barestash-authentication-authorization.spec.md`](barestash-authentication-authorization.spec.md) | Barestash identity, authentication, authorization, CLI session, Personal Access Token, scope, and revocation design |
| [`barestash-cli-design.spec.md`](barestash-cli-design.spec.md) | Barestash CLI command design: resource/action structure, MVP commands (including endpoint secrets), output modes, and error handling |
| [`barestash-backend.spec.md`](barestash-backend.spec.md) | Barestash backend design: storage model, ingest flow, REST/SSE API, auth, and MVP acceptance criteria |

See [docs/](../docs/) for technical design.
See [`../AGENTS.md`](../AGENTS.md) and [`../.agents/skills/`](../.agents/skills/) for coding agent workflows and guardrails.
