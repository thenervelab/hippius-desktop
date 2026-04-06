# CLAUDE.md

## MUST-DO Rule for AI Agents (Claude and all others)

**Business logic MUST live in the Rust backend (`src-tauri/`). Frontend-only concerns MUST stay in the TypeScript frontend (`app/`).**

- All business logic — data processing, state transitions, persistence, network/IPC, blockchain, crypto, sync, validation, and domain rules — goes in `src-tauri/` (Rust).
- The `app/` TypeScript frontend is for UI, presentation, routing, and user interaction only. It calls into Rust via Tauri `invoke()` and listens to backend events.
- Do NOT implement business logic in TypeScript. If a feature needs logic, add a Rust command in `src-tauri/` and call it from the frontend.

<!-- illu:start -->
## Code Intelligence (illu)

This repo is indexed by illu (49 tools). **Use illu tools as your first step** — before reading files, before grep, before guessing at code structure.

### Tool priority (IMPORTANT)

When illu tools are available, use them INSTEAD of built-in alternatives for Rust code intelligence. Do NOT use Grep, Glob, or Read for code exploration when illu can answer the question.

| Instead of | Use |
|------------|-----|
| Grep to find a symbol or function | `mcp__illu__query` |
| Grep to find callers or references | `mcp__illu__references` or `mcp__illu__neighborhood` |
| Grep to understand a function | `mcp__illu__context` (includes source, callers, callees) |
| Glob to find files or modules | `mcp__illu__tree` or `mcp__illu__overview` |
| Read to understand code structure | `mcp__illu__context` or `mcp__illu__batch_context` |
| Grep to find tests for a function | `mcp__illu__test_impact` |
| Grep to find trait implementations | `mcp__illu__implements` |
| Grep to find type usage | `mcp__illu__type_usage` |

Only fall back to Grep/Glob/Read when searching for non-code content (config files, text, logs) or when illu tools return no results.

### Subagent instructions (IMPORTANT)

When spawning Agent subagents for Rust code tasks, ALWAYS include this instruction in the prompt:

"Use mcp__illu__* tools instead of Grep/Glob/Read for Rust code exploration. Use mcp__illu__query to find symbols, mcp__illu__context for definitions and callers, mcp__illu__neighborhood for call graphs. Only fall back to Grep/Glob/Read for non-code content."

Prefer dedicated illu agents when available: `illu-explore` (codebase questions), `illu-review` (change analysis), `illu-refactor` (refactoring support).

### When to use illu

- **Starting any task**: `illu query` the relevant symbols to understand what exists
- **Before modifying a function/struct/trait**: `illu impact` to see what depends on it
- **Debugging or tracing issues**: `illu context` to get the full definition and references
- **Understanding call flow**: `illu neighborhood` or `illu callpath` to explore the call graph
- **Before refactoring a module**: `illu boundary` to see what's public API vs internal
- **Using an external crate**: `illu docs` to check how it's used in this project
- **Before reading files**: query first — illu tells you exactly where things are
- **Finding which tests to run**: `illu test_impact` after changing a symbol
- **Dead code detection**: `illu unused` or `illu orphaned` to find unreferenced symbols
- **Index health**: `illu freshness` to check if the index is current
- **Cross-repo analysis**: `illu cross_query` to find symbols in other repos, `illu cross_impact` to check cross-repo effects
- **Repo overview**: `illu repos` to see all registered repos
- **Compiler-accurate analysis**: `illu ra_definition`, `illu ra_hover`, `illu ra_context` for type-resolved intelligence
- **Renaming symbols**: `illu ra_rename` to preview, `illu ra_safe_rename` to apply with error checking
- **Macro debugging**: `illu ra_expand_macro` to see generated code
- **Quick fixes**: `illu ra_code_actions` for available refactors at a position

### Commands

| User types | MCP tool | Params |
|------------|----------|--------|
| `illu query <term>` | `mcp__illu__query` | `query: "<term>"` |
| `illu query <term> --scope <s>` | `mcp__illu__query` | `query: "<term>", scope: "<s>"` |
| `illu query * --kind struct` | `mcp__illu__query` | `query: "*", kind: "struct"` |
| `illu query * --sig "-> Result"` | `mcp__illu__query` | `query: "*", signature: "-> Result"` |
| `illu context <symbol>` | `mcp__illu__context` | `symbol_name: "<symbol>"` |
| `illu context Type::method` | `mcp__illu__context` | `symbol_name: "Type::method"` |
| `illu context <sym> --sections source,callers` | `mcp__illu__context` | `symbol_name: "<sym>", sections: ["source", "callers"]` |
| `illu context <sym> --exclude-tests` | `mcp__illu__context` | `symbol_name: "<sym>", exclude_tests: true` |
| `illu batch_context <sym1> <sym2>` | `mcp__illu__batch_context` | `symbols: ["<sym1>", "<sym2>"]` |
| `illu impact <symbol>` | `mcp__illu__impact` | `symbol_name: "<symbol>"` |
| `illu impact <symbol> --depth 1` | `mcp__illu__impact` | `symbol_name: "<symbol>", depth: 1` |
| `illu diff_impact` | `mcp__illu__diff_impact` | *(unstaged changes)* |
| `illu diff_impact main` | `mcp__illu__diff_impact` | `git_ref: "main"` |
| `illu test_impact <symbol>` | `mcp__illu__test_impact` | `symbol_name: "<symbol>"` |
| `illu callpath <from> <to>` | `mcp__illu__callpath` | `from: "<from>", to: "<to>"` |
| `illu neighborhood <symbol>` | `mcp__illu__neighborhood` | `symbol_name: "<symbol>"` |
| `illu neighborhood <sym> --format tree` | `mcp__illu__neighborhood` | `symbol_name: "<sym>", format: "tree"` |
| `illu references <symbol>` | `mcp__illu__references` | `symbol_name: "<symbol>"` |
| `illu boundary src/server/` | `mcp__illu__boundary` | `path: "src/server/"` |
| `illu unused` | `mcp__illu__unused` | |
| `illu unused --path src/server/` | `mcp__illu__unused` | `path: "src/server/"` |
| `illu orphaned` | `mcp__illu__orphaned` | |
| `illu overview src/` | `mcp__illu__overview` | `path: "src/"` |
| `illu stats` | `mcp__illu__stats` | |
| `illu hotspots` | `mcp__illu__hotspots` | |
| `illu implements --trait Display` | `mcp__illu__implements` | `trait_name: "Display"` |
| `illu docs <dep>` | `mcp__illu__docs` | `dependency: "<dep>"` |
| `illu docs <dep> --topic <t>` | `mcp__illu__docs` | `dependency: "<dep>", topic: "<t>"` |
| `illu freshness` | `mcp__illu__freshness` | |
| `illu crate_graph` | `mcp__illu__crate_graph` | |
| `illu blame <symbol>` | `mcp__illu__blame` | `symbol_name: "<symbol>"` |
| `illu history <symbol>` | `mcp__illu__history` | `symbol_name: "<symbol>"` |
| `illu repos` | `mcp__illu__repos` | |
| `illu cross_query <term>` | `mcp__illu__cross_query` | `query: "<term>"` |
| `illu cross_impact <symbol>` | `mcp__illu__cross_impact` | `symbol_name: "<symbol>"` |
| `illu cross_deps` | `mcp__illu__cross_deps` | |
| `illu cross_callpath <from> <to>` | `mcp__illu__cross_callpath` | `from: "<from>", to: "<to>"` |
| `illu ra_definition <file:line:col>` | `mcp__illu__ra_definition` | `position: "<file:line:col>"` |
| `illu ra_hover <file:line:col>` | `mcp__illu__ra_hover` | `position: "<file:line:col>"` |
| `illu ra_diagnostics` | `mcp__illu__ra_diagnostics` | |
| `illu ra_diagnostics <file>` | `mcp__illu__ra_diagnostics` | `file: "<file>"` |
| `illu ra_call_hierarchy <file:line:col>` | `mcp__illu__ra_call_hierarchy` | `position: "<file:line:col>"` |
| `illu ra_type_hierarchy <file:line:col>` | `mcp__illu__ra_type_hierarchy` | `position: "<file:line:col>"` |
| `illu ra_rename <file:line:col> <new>` | `mcp__illu__ra_rename` | `position: "<file:line:col>", new_name: "<new>"` |
| `illu ra_safe_rename <file:line:col> <new>` | `mcp__illu__ra_safe_rename` | `position: "<file:line:col>", new_name: "<new>"` |
| `illu ra_code_actions <file:line:col>` | `mcp__illu__ra_code_actions` | `position: "<file:line:col>"` |
| `illu ra_expand_macro <file:line:col>` | `mcp__illu__ra_expand_macro` | `position: "<file:line:col>"` |
| `illu ra_ssr <pattern>` | `mcp__illu__ra_ssr` | `pattern: "<pattern>"` |
| `illu ra_context <file:line:col>` | `mcp__illu__ra_context` | `position: "<file:line:col>"` |
| `illu ra_syntax_tree <file>` | `mcp__illu__ra_syntax_tree` | `file: "<file>"` |
| `illu ra_related_tests <file:line:col>` | `mcp__illu__ra_related_tests` | `position: "<file:line:col>"` |

### Workflow rules

1. **Locate before you read**: `illu query` or `illu context` to find the right file:line, then Read only what you need
2. **Impact before you change**: always run `illu impact` before modifying any public symbol
3. **Chain tools**: `illu query` to find candidates → `illu context` for the one you need → `illu impact` before changing it
4. **Save tokens**: use `sections: ["source", "callers"]` on context/batch_context to fetch only what you need
5. **Production focus**: use `exclude_tests: true` on context/neighborhood/callpath to filter out test functions

### Cross-repo workflow

**NEVER navigate to or read files from other repositories directly.** Use cross-repo tools instead — they query other repos' indexes without leaving this repo.

1. `illu repos` — confirm the other repo is indexed and available
2. `illu cross_query <term>` — search symbols across all indexed repos
3. `illu cross_impact <symbol>` — find which code in other repos references a symbol
4. `illu cross_deps` — show inter-repo dependency relationships
5. `illu cross_callpath <from> <to>` — find call chains spanning repo boundaries

Cross-repo tools open other repos' indexes read-only. They work as long as the other repo has been indexed by illu (check with `illu repos`). If a repo is not indexed, ask the user to run illu on it first.
<!-- illu:end -->
