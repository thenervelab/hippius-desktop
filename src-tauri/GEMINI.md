# GEMINI.md

<!-- illu:start -->
## Code Intelligence (illu)

This repo is indexed by illu (49 tools). **Use illu tools as your first step** — before reading files, before grep, before guessing at code structure.

### Tool priority (IMPORTANT)

When illu tools are available, use them INSTEAD of built-in alternatives for Rust code intelligence. Do NOT use Grep, Glob, or Read for code exploration when illu can answer the question.

| Instead of | Use |
|------------|-----|
| Grep to find a symbol or function | `mcp_illu_query` |
| Grep to find callers or references | `mcp_illu_references` or `mcp_illu_neighborhood` |
| Grep to understand a function | `mcp_illu_context` (includes source, callers, callees) |
| Glob to find files or modules | `mcp_illu_tree` or `mcp_illu_overview` |
| Read to understand code structure | `mcp_illu_context` or `mcp_illu_batch_context` |
| Grep to find tests for a function | `mcp_illu_test_impact` |
| Grep to find trait implementations | `mcp_illu_implements` |
| Grep to find type usage | `mcp_illu_type_usage` |

Only fall back to Grep/Glob/Read when searching for non-code content (config files, text, logs) or when illu tools return no results.

### Subagent instructions (IMPORTANT)

When spawning Agent subagents for Rust code tasks, ALWAYS include this instruction in the prompt:

"Use mcp_illu_* tools instead of Grep/Glob/Read for Rust code exploration. Use mcp_illu_query to find symbols, mcp_illu_context for definitions and callers, mcp_illu_neighborhood for call graphs. Only fall back to Grep/Glob/Read for non-code content."

Prefer dedicated illu agents when available: `illu-explore` (codebase questions), `illu-review` (change analysis), `illu-refactor` (refactoring support).

### When to use illu

- **Starting any task**: `@illu query` the relevant symbols to understand what exists
- **Before modifying a function/struct/trait**: `@illu impact` to see what depends on it
- **Debugging or tracing issues**: `@illu context` to get the full definition and references
- **Understanding call flow**: `@illu neighborhood` or `@illu callpath` to explore the call graph
- **Before refactoring a module**: `@illu boundary` to see what's public API vs internal
- **Using an external crate**: `@illu docs` to check how it's used in this project
- **Before reading files**: query first — illu tells you exactly where things are
- **Finding which tests to run**: `@illu test_impact` after changing a symbol
- **Dead code detection**: `@illu unused` or `@illu orphaned` to find unreferenced symbols
- **Index health**: `@illu freshness` to check if the index is current
- **Cross-repo analysis**: `@illu cross_query` to find symbols in other repos, `@illu cross_impact` to check cross-repo effects
- **Repo overview**: `@illu repos` to see all registered repos
- **Compiler-accurate analysis**: `@illu ra_definition`, `@illu ra_hover`, `@illu ra_context` for type-resolved intelligence
- **Renaming symbols**: `@illu ra_rename` to preview, `@illu ra_safe_rename` to apply with error checking
- **Macro debugging**: `@illu ra_expand_macro` to see generated code
- **Quick fixes**: `@illu ra_code_actions` for available refactors at a position

### Commands

| User types | MCP tool | Params |
|------------|----------|--------|
| `@illu query <term>` | `mcp_illu_query` | `query: "<term>"` |
| `@illu query <term> --scope <s>` | `mcp_illu_query` | `query: "<term>", scope: "<s>"` |
| `@illu query * --kind struct` | `mcp_illu_query` | `query: "*", kind: "struct"` |
| `@illu query * --sig "-> Result"` | `mcp_illu_query` | `query: "*", signature: "-> Result"` |
| `@illu context <symbol>` | `mcp_illu_context` | `symbol_name: "<symbol>"` |
| `@illu context Type::method` | `mcp_illu_context` | `symbol_name: "Type::method"` |
| `@illu context <sym> --sections source,callers` | `mcp_illu_context` | `symbol_name: "<sym>", sections: ["source", "callers"]` |
| `@illu context <sym> --exclude-tests` | `mcp_illu_context` | `symbol_name: "<sym>", exclude_tests: true` |
| `@illu batch_context <sym1> <sym2>` | `mcp_illu_batch_context` | `symbols: ["<sym1>", "<sym2>"]` |
| `@illu impact <symbol>` | `mcp_illu_impact` | `symbol_name: "<symbol>"` |
| `@illu impact <symbol> --depth 1` | `mcp_illu_impact` | `symbol_name: "<symbol>", depth: 1` |
| `@illu diff_impact` | `mcp_illu_diff_impact` | *(unstaged changes)* |
| `@illu diff_impact main` | `mcp_illu_diff_impact` | `git_ref: "main"` |
| `@illu test_impact <symbol>` | `mcp_illu_test_impact` | `symbol_name: "<symbol>"` |
| `@illu callpath <from> <to>` | `mcp_illu_callpath` | `from: "<from>", to: "<to>"` |
| `@illu neighborhood <symbol>` | `mcp_illu_neighborhood` | `symbol_name: "<symbol>"` |
| `@illu neighborhood <sym> --format tree` | `mcp_illu_neighborhood` | `symbol_name: "<sym>", format: "tree"` |
| `@illu references <symbol>` | `mcp_illu_references` | `symbol_name: "<symbol>"` |
| `@illu boundary src/server/` | `mcp_illu_boundary` | `path: "src/server/"` |
| `@illu unused` | `mcp_illu_unused` | |
| `@illu unused --path src/server/` | `mcp_illu_unused` | `path: "src/server/"` |
| `@illu orphaned` | `mcp_illu_orphaned` | |
| `@illu overview src/` | `mcp_illu_overview` | `path: "src/"` |
| `@illu stats` | `mcp_illu_stats` | |
| `@illu hotspots` | `mcp_illu_hotspots` | |
| `@illu implements --trait Display` | `mcp_illu_implements` | `trait_name: "Display"` |
| `@illu docs <dep>` | `mcp_illu_docs` | `dependency: "<dep>"` |
| `@illu docs <dep> --topic <t>` | `mcp_illu_docs` | `dependency: "<dep>", topic: "<t>"` |
| `@illu freshness` | `mcp_illu_freshness` | |
| `@illu crate_graph` | `mcp_illu_crate_graph` | |
| `@illu blame <symbol>` | `mcp_illu_blame` | `symbol_name: "<symbol>"` |
| `@illu history <symbol>` | `mcp_illu_history` | `symbol_name: "<symbol>"` |
| `@illu repos` | `mcp_illu_repos` | |
| `@illu cross_query <term>` | `mcp_illu_cross_query` | `query: "<term>"` |
| `@illu cross_impact <symbol>` | `mcp_illu_cross_impact` | `symbol_name: "<symbol>"` |
| `@illu cross_deps` | `mcp_illu_cross_deps` | |
| `@illu cross_callpath <from> <to>` | `mcp_illu_cross_callpath` | `from: "<from>", to: "<to>"` |
| `@illu ra_definition <file:line:col>` | `mcp_illu_ra_definition` | `position: "<file:line:col>"` |
| `@illu ra_hover <file:line:col>` | `mcp_illu_ra_hover` | `position: "<file:line:col>"` |
| `@illu ra_diagnostics` | `mcp_illu_ra_diagnostics` | |
| `@illu ra_diagnostics <file>` | `mcp_illu_ra_diagnostics` | `file: "<file>"` |
| `@illu ra_call_hierarchy <file:line:col>` | `mcp_illu_ra_call_hierarchy` | `position: "<file:line:col>"` |
| `@illu ra_type_hierarchy <file:line:col>` | `mcp_illu_ra_type_hierarchy` | `position: "<file:line:col>"` |
| `@illu ra_rename <file:line:col> <new>` | `mcp_illu_ra_rename` | `position: "<file:line:col>", new_name: "<new>"` |
| `@illu ra_safe_rename <file:line:col> <new>` | `mcp_illu_ra_safe_rename` | `position: "<file:line:col>", new_name: "<new>"` |
| `@illu ra_code_actions <file:line:col>` | `mcp_illu_ra_code_actions` | `position: "<file:line:col>"` |
| `@illu ra_expand_macro <file:line:col>` | `mcp_illu_ra_expand_macro` | `position: "<file:line:col>"` |
| `@illu ra_ssr <pattern>` | `mcp_illu_ra_ssr` | `pattern: "<pattern>"` |
| `@illu ra_context <file:line:col>` | `mcp_illu_ra_context` | `position: "<file:line:col>"` |
| `@illu ra_syntax_tree <file>` | `mcp_illu_ra_syntax_tree` | `file: "<file>"` |
| `@illu ra_related_tests <file:line:col>` | `mcp_illu_ra_related_tests` | `position: "<file:line:col>"` |

### Workflow rules

1. **Locate before you read**: `@illu query` or `@illu context` to find the right file:line, then Read only what you need
2. **Impact before you change**: always run `@illu impact` before modifying any public symbol
3. **Chain tools**: `@illu query` to find candidates → `@illu context` for the one you need → `@illu impact` before changing it
4. **Save tokens**: use `sections: ["source", "callers"]` on context/batch_context to fetch only what you need
5. **Production focus**: use `exclude_tests: true` on context/neighborhood/callpath to filter out test functions

### Cross-repo workflow

**NEVER navigate to or read files from other repositories directly.** Use cross-repo tools instead — they query other repos' indexes without leaving this repo.

1. `@illu repos` — confirm the other repo is indexed and available
2. `@illu cross_query <term>` — search symbols across all indexed repos
3. `@illu cross_impact <symbol>` — find which code in other repos references a symbol
4. `@illu cross_deps` — show inter-repo dependency relationships
5. `@illu cross_callpath <from> <to>` — find call chains spanning repo boundaries

Cross-repo tools open other repos' indexes read-only. They work as long as the other repo has been indexed by illu (check with `@illu repos`). If a repo is not indexed, ask the user to run illu on it first.
<!-- illu:end -->
