# illu-rs Code Intelligence

This project is indexed by illu-rs. Use the following MCP tools to explore the codebase and its dependencies.

## Tools (49 available)

### Search & Navigate

- **query** — Search symbols, docs, files, bodies, or string literals. Filters: kind, attribute, signature, path.
- **context** — Full symbol context: source, callers, callees, trait impls. Supports `Type::method`, `sections` filter, `exclude_tests`.
- **batch_context** — Context for multiple symbols in one call.
- **symbols_at** — Find symbols at a file:line location.
- **overview** — Public symbols under a path, grouped by file.
- **tree** — File/module hierarchy.

### Impact Analysis

- **impact** — Transitive dependents of a symbol (configurable depth).
- **diff_impact** — Batch impact for all symbols in a git diff.
- **test_impact** — Which tests break when changing a symbol.
- **crate_impact** — Which workspace crates are affected.

### Call Graph

- **callpath** — Shortest or all paths between two symbols.
- **neighborhood** — Callers/callees within N hops (list or tree format).
- **references** — Unified view: call sites, type usage, trait impls.
- **type_usage** — Where a type appears in signatures and struct fields.
- **file_graph** — File-level dependency graph.
- **graph_export** — Export call or file graphs as DOT, compact edge list, or summary.

### Discovery & Audit

- **unused** — Symbols with no incoming references.
- **orphaned** — Symbols with no callers AND no test coverage.
- **boundary** — Public API vs internal-only classification for a module.
- **similar** — Functions with matching signatures and call patterns.
- **rename_plan** — All locations to update before renaming a symbol.
- **doc_coverage** — Undocumented symbols with coverage percentage.
- **hotspots** — Most-referenced, most-complex, and largest functions.
- **stats** — File/symbol counts, test coverage, top references.

### Dependencies & Git

- **docs** — Version-pinned dependency documentation, filterable by topic.
- **implements** — Trait/type implementation relationships.
- **crate_graph** — Workspace inter-crate dependency graph.
- **blame** — Git blame on a symbol's line range.
- **history** — Git commit history for a symbol, with optional diffs.
- **freshness** — Index staleness check.
- **health** — Index quality diagnosis.

### Cross-Repo

- **repos** — Dashboard of all registered repos with status and symbol counts.
- **cross_query** — Search symbols across all registered repos.
- **cross_impact** — Find references to a symbol in other repos.
- **cross_deps** — Inter-repo dependency relationships via Cargo.toml.
- **cross_callpath** — Find call chains spanning repo boundaries.

### rust-analyzer (compiler-accurate, positions use file:line:col)

- **ra_definition** — Go to definition — resolves through macros, trait impls, generics.
- **ra_hover** — Type information and documentation at a position.
- **ra_diagnostics** — Compilation errors and warnings, optionally filtered by file.
- **ra_call_hierarchy** — Callers and/or callees at a position (direction: in/out/both).
- **ra_type_hierarchy** — Supertypes (traits) and subtypes for a type.
- **ra_rename** — Preview rename impact: affected files and reference counts.
- **ra_safe_rename** — Apply a rename with compilation error checking.
- **ra_code_actions** — Available quick fixes and refactors at a position.
- **ra_expand_macro** — Expand macro at a position, showing generated code.
- **ra_ssr** — Structural search and replace (e.g. `foo($a) ==>> bar($a)`).
- **ra_context** — Full compiler-accurate context: definition, hover, callers, callees, impls, tests.
- **ra_syntax_tree** — Show syntax tree for a file (debugging/parse structure).
- **ra_related_tests** — Find tests related to a symbol — more accurate than text matching.

## Direct Dependencies

- aes
- alloy-signer
- alloy-signer-local
- aws-credential-types
- aws-sdk-s3
- base64
- bip39
- blake2
- bs58
- cbc
- chrono
- coins-bip39
- dirs
- dotenvy
- ed25519-dalek
- flate2
- futures
- hcfs-client
- hcfs-shared
- hex
- hostname
- k256
- md5
- notify
- parity-scale-codec
- rand
- reqwest
- schnorrkel
- serde
- serde_json
- serde_yaml
- sha2
- sp-core
- sqlx
- substrate-bip39
- subxt
- sysinfo
- tar
- tauri
- tauri-plugin-deep-link
- tauri-plugin-dialog
- tauri-plugin-fs
- tauri-plugin-http
- tauri-plugin-opener
- tauri-plugin-process
- tauri-plugin-shell
- tempfile
- thiserror
- tiny-keccak
- tokio
- tokio-util
- tracing
- tracing-subscriber
- uuid
- which
- zeroize
- zip
