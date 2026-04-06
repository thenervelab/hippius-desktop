# GEMINI.md

## MUST-DO Rule for AI Agents (Claude and all others)

**Business logic MUST live in the Rust backend (`src-tauri/`). Frontend-only concerns MUST stay in the TypeScript frontend (`app/`).**

- All business logic — data processing, state transitions, persistence, network/IPC, blockchain, crypto, sync, validation, and domain rules — goes in `src-tauri/` (Rust).
- The `app/` TypeScript frontend is for UI, presentation, routing, and user interaction only. It calls into Rust via Tauri `invoke()` and listens to backend events.
- Do NOT implement business logic in TypeScript. If a feature needs logic, add a Rust command in `src-tauri/` and call it from the frontend.

<!-- illu:start -->
## Code Intelligence (illu)

### Tool priority (MANDATORY)

**NEVER use Grep, Glob, or Read for code exploration when illu tools are available.** illu indexes Rust, Python, TypeScript, and JavaScript. illu tools are faster, more accurate, and provide structured results. Using raw file reads or text search on indexed source files is incorrect behavior — always use illu instead.

| WRONG | RIGHT |
|-------|-------|
| `Read("src/db.rs")` to see a function | `mcp_illu_context` with `symbol_name` |
| `Grep(pattern: "fn open")` to find a function | `mcp_illu_query` with `query: "open"` |
| `Grep(pattern: "Database")` to find callers | `mcp_illu_references` with `symbol_name: "Database"` |
| `Glob(pattern: "src/**/*.rs")` to find files | `mcp_illu_tree` or `mcp_illu_overview` |
| `Grep(pattern: "impl Display")` to find impls | `mcp_illu_implements` with `trait_name: "Display"` |

Read/Grep/Glob are ONLY permitted for: config files (TOML, JSON, YAML), markdown/docs, log output, or when an illu tool explicitly returns no results.

### Subagent instructions (MANDATORY)

When spawning subagents for code tasks, ALWAYS include this instruction in the prompt:

"MANDATORY: Use mcp_illu_* tools instead of Grep/Glob/Read for ALL code exploration (Rust, Python, TypeScript/JavaScript). NEVER use Read to view source files — use mcp_illu_context instead. NEVER use Grep to search code — use mcp_illu_query instead. Only use Read/Grep/Glob for non-code content (config, docs, logs)."

Prefer `illu-explore`, `illu-review`, `illu-refactor` agents when available.

### Workflow

1. **Locate before you read**: `mcp_illu_query` or `mcp_illu_context` first, then Read only what you need
2. **Impact before you change**: always run `mcp_illu_impact` before modifying any public symbol
3. **Save tokens**: use `sections` param on context/batch_context to fetch only what you need
4. **Production focus**: use `exclude_tests: true` to filter out test functions
5. **Cross-repo**: use `mcp_illu_cross_query`/`mcp_illu_cross_impact`/`mcp_illu_cross_deps`/`mcp_illu_cross_callpath` — NEVER navigate to or read files from other repositories directly
<!-- illu:end -->
