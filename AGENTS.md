# Project agent instructions

## Orchestration

- Use Terra as the orchestrator for project work.
- Delegate suitable research, implementation, and review work to subagents.
- Try these models in order for each delegated task:
  1. `neon/gpt-6-luna`
  2. `neon/glm-5-3-flash`
  3. `openai-codex/gpt-6-luna`
- Move to the next model when the previous model is unavailable or fails.
- Report failures and preserve any partial work before retrying.
- If all three models fail, stop and ask the user how to proceed.
- The orchestrator owns decisions, integration, and final verification.

## Specifications

- Use OpenSpec for feature proposals, requirements, and designs.
- Keep implementation aligned with the approved OpenSpec change.
