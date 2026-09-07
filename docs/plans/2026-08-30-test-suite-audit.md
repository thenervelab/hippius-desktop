# Test-suite audit catalog

Date: 2026-08-30
Policy: [`docs/testing-policy.md`](../testing-policy.md)
Scope: every current test file, once. Later PRs implement only `gap` / `gap-companion` / `move` / `delete` rows.

## Summary

| Layer | Files | Non-keep |
| --- | ---: | ---: |
| FE pin | 2 | 0 |
| Vitest | 122 | 0 |
| WDIO smoke | 1 | 0 |
| hermetic integration | 29 | 0 |
| in-module Rust | 126 | 0 |
| live | 3 | 0 |
| mock-server | 3 | 0 |
| replay harness | 2 | 0 |
| script unit | 1 | 0 |
| source pin | 17 | 0 |
| **total test files** | **306** | **0** |

Existing tests are almost entirely `keep`. PR1–2 closed the catalog gaps.

## Non-keep test files (actionable)

None remaining.

## Gaps — untested Rust modules that need a test (PR2)

Closed. In-module / source-pin tests landed on:

| Path | Test | Notes |
| --- | --- | --- |
| `src-tauri/src/api/indexer.rs` | `require_indexer_api_key` | Missing/blank key is an error, never a zero client. |
| `src-tauri/src/auth/logout.rs` | `auth_wiring_pins.rs` | Persist (`auth_session_repo::clear` + `clear_api_token`) before `substrate_address = None`. |
| `src-tauri/src/auth/ssh_keys.rs` | list-query defaults + serde | IPC stays reachable with VM UI gated. |
| `src-tauri/src/billing/subscriptions.rs` | `assemble_subscription_data` | Empty/missing plans never claim highest (upgrade CTA). |
| `src-tauri/src/infra/vm.rs` | first-line `require_eligible` pin + `logo_url` | Not VM UI. |
| `src-tauri/src/sync/drive/device.rs` | validate + sqlite roundtrip | Blank is Validation. |
| `src-tauri/src/sync/failure/failure_commands.rs` | `tests/failure_commands_wiring.rs` | Exclude fail-closed; skip tolerant. |
| `src-tauri/src/sync/fileops/files/asset_scope.rs` | shared `require_registered_sync_path` pin | Audit H-4. |
| `src-tauri/src/sync/fileops/files/resolve.rs` | unregistered / other-owner Validation |  |
| `src-tauri/src/utils/bookmarks.rs` | `persist_bookmark_bytes` SQL | ObjC bookmark create stays OS/FFI. |
| `src-tauri/src/utils/preferences.rs` | get/save roundtrip |  |
| `src-tauri/src/wallet/repo.rs` | owner isolation, first-active, promote-on-delete, public projection |  |

## Skip — untested modules that stay untested

Glue, types, error enums, feature-gated engines, re-export `mod.rs` files, or already pinned at another layer.

| Path | Why skip |
| --- | --- |
| `src-tauri/src/auth/billing_auth.rs` | Identity routing already pinned in tests/auth_wiring_pins.rs::billing_auth_routes_through_verified_derive. Do not duplicate. |
| `src-tauri/src/notifications/settings.rs` | Remote HTTP proxy (`GET`/`PATCH /api/notifications/settings/`). Local per-account toggles live in `notifications/crud.rs` and are already covered by `tests/local_db_commands.rs`. |
| `src-tauri/src/blockchain/bridge/client.rs` | HTTP client glue. |
| `src-tauri/src/blockchain/bridge/config.rs` | Config constants. |
| `src-tauri/src/blockchain/bridge/deposit.rs` | Funds-critical write path: compile-verified; funded testnet smoke on release-checklist. No mock chain. |
| `src-tauri/src/blockchain/bridge/explorer.rs` | Explorer URL helpers; low risk. |
| `src-tauri/src/blockchain/bridge/runtime.rs` | Runtime glue. |
| `src-tauri/src/blockchain/bridge/types.rs` | Types only. |
| `src-tauri/src/blockchain/bridge/withdraw.rs` | Same as deposit.rs. |
| `src-tauri/src/blockchain/runtime.rs` | Runtime glue. |
| `src-tauri/src/blockchain/state.rs` | State holder. |
| `src-tauri/src/finder_bridge/error.rs` | Error type only. |
| `src-tauri/src/finder_bridge/lifecycle.rs` | OS/socket glue; enablement.rs has tests. Stay on release-checklist. |
| `src-tauri/src/shares/client.rs` | HTTP client glue; commands/mock suites cover the surface. |
| `src-tauri/src/splash.rs` | Window lifecycle; hippius_startup_window.rs pins boot. |
| `src-tauri/src/sync/drive.rs` | Re-export group module. |
| `src-tauri/src/sync/failure.rs` | Re-export group module. |
| `src-tauri/src/sync/fileops.rs` | Re-export group module. |
| `src-tauri/src/sync/migrate.rs` | Re-export group module. |
| `src-tauri/src/sync/projection.rs` | Re-export group module. |
| `src-tauri/src/sync/shared.rs` | Re-export group module. |
| `src-tauri/src/vpn/engine.rs` | Trait; state.rs tests use FakeMeshEngine. |
| `src-tauri/src/vpn/error.rs` | Error type only. |
| `src-tauri/src/vpn/events.rs` | Event names; UI gated off. |
| `src-tauri/src/vpn/fake_engine.rs` | Test double, used by state tests. |
| `src-tauri/src/vpn/netbird_engine.rs` | Behind off-by-default netbird-vpn feature. |

## Lockstep pairs (keep both sides)

| FE | Rust | Contract |
| --- | --- | --- |
| `app/lib/__tests__/crossBoundaryContract.test.ts` | `rename.rs` + `tests/fixtures/name_validation_cases.json` | Rename accept/reject verdict |
| same file | `recent_uploads` / `relPath.ts` + `path_normalization_cases.json` | Rel-path trim |
| `app/lib/__tests__/ipcContract.test.ts` | `main.rs` `generate_handler!` | Command **names** only |
| `app/lib/utils/__tests__/filePreviewType.test.ts` | `media_preview.rs` `preview_read_ceiling_*` | Byte caps |
| `app/components/page-sections/drive/__tests__/renameValidation.test.ts` | Rust `validate_new_name` | Instant FE copy; verdict lockstep is the JSON fixture test — do not delete the FE unit tests |

PR3 is therefore **ipcContract completeness** plus any fixture drift, not a new rename lockstep.

Amendment: `ipcContract.test.ts` now also scans `command: "…"` (useInvokeQuery/Mutation) and `useVMAction("…")`. Those were invisible to the `invoke("…")` regex, so SSH/VM/billing hooks could rename a command without failing CI. Splash cosmetic `command:` values (`check_updates`, `checking_tools`) are allow-listed as non-IPC.

## WDIO

One spec: `e2e/specs/syncWidget.e2e.ts` — **keep**. Catalog found no additional renderer-only failure a unit/replay cannot see, so PR5 does **not** add specs. Cap remains ≤5; not CI.

## Live lane

| Suite | In `e2e-live.yml` | Secret |
| --- | --- | --- |
| `shared_drives_real_backend.rs` | yes (`both` / `shared_drives`) | owner+member bearers |
| `folder_shares_real_backend.rs` | yes (`both` / `folder_shares`) | user bearer |
| `folder_entries_real_backend.rs` | yes (`both` / `all` / `folder_entries`) | `HCFS_DESKTOP_E2E_ADMIN_BEARER` (GitHub secret; never a literal in this repo) |

Amendment: `src-tauri/tests/live_lane_wiring.rs` (source pin, keep) — every `*_real_backend.rs` must be a `cargo test --test` line in `e2e-live.yml`.

## Full inventory (every test file, keep unless noted above)

### FE pin (2)

| Path | Verdict | Reason |
| --- | --- | --- |
| `app/lib/__tests__/crossBoundaryContract.test.ts` | keep | Cross-boundary name/fixture lockstep with Rust (not a second implementation of domain rules). |
| `app/lib/__tests__/ipcContract.test.ts` | keep | Command **names**: `invoke`/`invokeWithTimeout` literals, `command:` fields, `useVMAction("…")`. |

### Vitest (121)

| Path | Verdict | Reason |
| --- | --- | --- |
| `app/(pages)/__tests__/FinderShareListener.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/(pages)/__tests__/SyncStatusDialog.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/(pages)/__tests__/SyncStatusHandler.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/(pages)/__tests__/syncStatusDialogLogic.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/(pages)/shares/__tests__/shareRowDisplay.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/__tests__/FinderExtensionGuard.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/auth/__tests__/carouselCrop.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/auth/onboarding/__tests__/onboardingData.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/drive/__tests__/FilesNoEntriesFound.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/drive/__tests__/FilterChips.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/drive/__tests__/FilterPills.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/drive/__tests__/ShareDriveModal.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/drive/__tests__/ShareFileModal.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/drive/__tests__/SharedLinkBadge.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/drive/__tests__/StagedChangesDialog.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/drive/__tests__/folderShareWiring.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/drive/__tests__/renameValidation.test.ts` | keep | Instant FE feedback; verdict lockstep lives in crossBoundaryContract.test.ts + shared JSON fixture. Do not delete. |
| `app/components/page-sections/drive/__tests__/shareDriveModalState.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/drive/__tests__/sharedBadgeTooltip.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/drive/__tests__/stagedChangesLogic.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/drive/__tests__/statsSourceSelection.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/drive/__tests__/viewerSelection.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/drive/file-preview/__tests__/LivePhotoToggle.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/drive/file-preview/__tests__/UnifiedFilePreview.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/drive/file-preview/__tests__/officeRenderers.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/drive/file-preview/__tests__/previewBytes.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/drive/files-table/NameCell.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/drive/migration/__tests__/migrationCounts.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/home/__tests__/storageOverviewState.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/notifications/__tests__/notificationStore.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/settings/multi-folder-sync/__tests__/ExclusionsDialog.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/settings/multi-folder-sync/__tests__/LocalFoldersSection.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/settings/multi-folder-sync/__tests__/SharedWithMeSection.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/settings/multi-folder-sync/__tests__/folderMenuGating.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/settings/multi-folder-sync/__tests__/sharedWithMeState.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/page-sections/wallet/__tests__/bridgeValidation.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/recovery/__tests__/AccountRecoveryDialog.unlock.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/recovery/__tests__/ChangeRecoveryPasswordDialog.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/recovery/__tests__/RecoveryEventListener.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/recovery/__tests__/_shared.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/recovery/__tests__/recoveryRotationLogic.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/sidebar/__tests__/filterNavSections.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/sidebar/__tests__/settingsNavGating.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/sidebar/__tests__/sidebarSearchState.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/splash-screen-v2/__tests__/splashReset.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/ui/__tests__/ConflictsBanner.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/ui/__tests__/SyncReauthRequiredAlert.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/ui/__tests__/selectInFramedDialog.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/ui/info-tooltip.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/ui/search-input/__tests__/SearchInput.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/components/updater/__tests__/releaseChannelCopy.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/contexts/__tests__/fileSelectionLogic.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/__tests__/theme.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/tauri/__tests__/sharedDrives.test.ts` | keep | `isSharedDrivesUnavailable` keys on subkind so a feature-off server never toasts. |
| `app/lib/auth/__tests__/buildOAuthSession.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/auth/__tests__/deepLinkDedup.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/auth/__tests__/oauthSessionHint.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/auth/__tests__/scheduleOAuthSyncInit.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/auth/__tests__/sessionTiming.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/bridge/__tests__/noDuplicatedDomainConstants.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/global-atoms/__tests__/hasConfiguredDrives.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/helpers/__tests__/notificationCategories.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/tryAutoInitSync.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useAddressValidation.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useCreditCheck.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useCreditsExhausted.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useDeleteFile.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useDriveStatuses.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useFileFailure.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useFileLiveProgress.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useFilesNotification.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useFilteredFiles.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useFolderShares.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useInfiniteScroll.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useLoadMoreSentinel.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useMetadataStale.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useRefreshWhileSyncing.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useStagedChanges.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useSyncEvents.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useSyncSnapshot.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useThumbnail.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useTraySync.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useViewableFileUrl.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/__tests__/useVpn.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/api/__tests__/useInvokeMutation.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/hooks/api/__tests__/useInvokeQuery.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/store/__tests__/resetSyncSession.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/test-utils/__tests__/tauriMock.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/tray/__tests__/trayIconState.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/tray/__tests__/traySyncSummary.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/tray/__tests__/useTrayPanelData.test.tsx` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/upload-feed/__tests__/groupUploadFeed.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/upload-feed/__tests__/mergeUploadFeed.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/chartAnimation.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/cloudOnly.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/deleteFolderError.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/dispatchTauriError.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/downloadFolder.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/driveRowStatus.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/errorUtils.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/failureMessage.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/filePreviewType.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/fileSort.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/filesViewMode.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/folderShareGating.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/formatBytes.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/formatPlanckToHip.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/formatUploadedDate.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/getTileTypeFromExtension.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/isMacPlatform.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/mediaNavigation.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/planckUnits.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/relPath.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/renameGating.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/skeletonGate.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/timeRelative.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/txOutcome.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/__tests__/userPreferencesDb.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/preview/__tests__/sanitizeMarkup.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/preview/__tests__/spreadsheetFallback.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/utils/preview/__tests__/spreadsheetPreview.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |
| `app/lib/vpn/__tests__/vmVpnView.test.ts` | keep | Pure UI / gating / hook wiring with mocked invoke. |

### WDIO smoke (1)

| Path | Verdict | Reason |
| --- | --- | --- |
| `e2e/specs/syncWidget.e2e.ts` | keep | Production-webview paint; do not grow for bugs a replay can catch. |

### hermetic integration (29)

| Path | Verdict | Reason |
| --- | --- | --- |
| `src-tauri/tests/auth_commands.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/auth_tokens.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/blockchain_commands.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/crypto_migration.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/drive_lifecycle_race.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/drive_status.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/eligibility_enforcement.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/file_commands.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/hippius_402_e2e.rs` | keep | Named e2e but is a hermetic callback-orchestration test (desktop reaction to 402), not a live server. Matches policy: client behavior. |
| `src-tauri/tests/hippius_activity_truth.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/hippius_conflict_resolution.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/hippius_credits_exhausted_event.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/hippius_eligibility_pricing.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/hippius_file_failed_event.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/hippius_folder_entries_backfill.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/hippius_relative_path_backfill.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/hippius_snapshot_failure_status.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/hippius_startup_window.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/hippius_upload_processing_watchdog.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/intent_lifecycle.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/list_sync_folder_nested.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/local_db_commands.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/preparing_on_add.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/recovery.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/share_keystore.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/sync_cancel_notifications.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/sync_mnemonic_resolution.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `src-tauri/tests/tray_panel_shown_event.rs` | keep | Domain / IPC / SQLite / fixture-driven hermetic coverage. |
| `windows/HippiusShell/src/wire.rs` | keep | Windows shell-extension crate; CI windows-shell-ext job. |

### in-module Rust (126)

| Path | Verdict | Reason |
| --- | --- | --- |
| `src-tauri/src/api/client.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/app_state.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/auth/account_key.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/auth/auth_session_repo.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/auth/contacts.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/auth/keychain.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/auth/login.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/auth/oauth.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/auth/service.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/auth/session_restore.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/auth/state.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/auth/token_keychain.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/auth/tokens.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/billing/account_cache.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/billing/charts.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/billing/credit_balance.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/billing/credits.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/billing/drive_credits.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/billing/drive_storage.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/billing/eligibility.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/billing/queries.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/billing/storage_overview.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/blockchain/bridge/contract.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/blockchain/bridge/convert.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/blockchain/bridge/history.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/blockchain/bridge/queries.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/blockchain/bridge/status.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/blockchain/client.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/blockchain/convert.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/blockchain/helpers.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/blockchain/queries.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/blockchain/staking.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/blockchain/subscription.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/blockchain/transfers.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/blockchain/types.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/console_access.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/crypto/store.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/error.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/finder_bridge/cli.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/finder_bridge/commands.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/finder_bridge/dispatch.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/finder_bridge/enablement.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/finder_bridge/endpoint.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/finder_bridge/protocol.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/finder_bridge/resolve.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/finder_bridge/socket.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/lib.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/main.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/media_preview.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/notifications/credits.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/notifications/crud.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/notifications/mod.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/power.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/recovery.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/recovery_binding.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/recovery_proof.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/release_channel.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/shared_drives/commands.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/shared_drives/grant.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/shares/capabilities.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/shares/commands.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/shares/history.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/shares/keystore.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/shares/origin.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/drive/config.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/drive/control.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/drive/drive_status.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/drive/identity.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/drive/lifecycle/callbacks.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/drive/lifecycle.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/drive/lifecycle_guard.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/drive/paths.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/drive/selective.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/failure/credits_exhausted.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/failure/error_notify.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/failure/failure_repo.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/failure/failure_tracking.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/failure/folder_restore_notify.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/fileops/files/add.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/fileops/files/delete.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/fileops/files/dir_stats.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/fileops/files/export_zip.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/fileops/files/listing.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/fileops/files/pathops.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/fileops/files/recent.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/fileops/files/rename.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/fileops/files/synced_state.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/fileops/files/user_files.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/fileops/folders.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/fileops/recent_uploads.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/fileops/remote.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/migrate/folder_entries_backfill.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/migrate/folder_entries_materialize.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/migrate/folder_entries_reconcile.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/migrate/migration.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/migrate/relative_path_backfill.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/migrate/relative_path_backfill_reset.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/migrate/user_stopped_migration.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/migrate/user_stopped_reversal.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/projection/events.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/projection/intent.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/projection/logic.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/projection/preparing.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/projection/progress.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/projection/status.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/projection/tauri_bridge.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/projection/upload_processing.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/shared/chunk_reclaim.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/shared/mnemonic.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/sync/shared/region.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/tray/geometry.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/tray/panel.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/updates.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/utils/app_location.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/utils/logs.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/utils/platform_info.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/utils/schema.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/utils/support.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/utils/tray_menu.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/vpn/commands.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/vpn/config.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/vpn/mod.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/vpn/state.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/wallet/commands.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/wallet/crypto.rs` | keep | Hermetic unit tests colocated with domain logic. |
| `src-tauri/src/wallet/rate_limit.rs` | keep | Hermetic unit tests colocated with domain logic. |

### live (3)

| Path | Verdict | Reason |
| --- | --- | --- |
| `src-tauri/tests/folder_entries_real_backend.rs` | gap-companion | Live suite exists; e2e-live.yml does not run it (needs ADMIN bearer). |
| `src-tauri/tests/folder_shares_real_backend.rs` | keep | Live server behavior; already in e2e-live.yml. |
| `src-tauri/tests/shared_drives_real_backend.rs` | keep | Live server behavior; already in e2e-live.yml. |

### mock-server (3)

| Path | Verdict | Reason |
| --- | --- | --- |
| `src-tauri/tests/migration_server_mock.rs` | keep | Hermetic HTTP doubles for this client's request shapes / error mapping. |
| `src-tauri/tests/shared_drive_server_mock.rs` | keep | Hermetic HTTP doubles for this client's request shapes / error mapping. |
| `src-tauri/tests/shares_server_mock.rs` | keep | Hermetic HTTP doubles for this client's request shapes / error mapping. |

### replay harness (2)

| Path | Verdict | Reason |
| --- | --- | --- |
| `app/(pages)/__tests__/syncWidgetReplay.test.tsx` | keep | Stateful FE projection over a snapshot/event stream. |
| `app/lib/upload-feed/__tests__/uploadFeedReplay.test.tsx` | keep | Stateful FE projection over a snapshot/event stream. |

### script unit (1)

| Path | Verdict | Reason |
| --- | --- | --- |
| `scripts/__tests__/devEnv.test.mjs` | keep | Dev-env rewrite helpers; hermetic Node. |

### source pin (17)

| Path | Verdict | Reason |
| --- | --- | --- |
| `src-tauri/tests/account_authority_guard.rs` | keep | Static pin that a refactor can drop a call site without failing unit tests. |
| `src-tauri/tests/auth_wiring_pins.rs` | keep | Static pin that a refactor can drop a call site without failing unit tests. |
| `src-tauri/tests/block_subscription_backoff_wiring.rs` | keep | Static pin that a refactor can drop a call site without failing unit tests. |
| `src-tauri/tests/bundle_metadata_pin.rs` | keep | Static pin that a refactor can drop a call site without failing unit tests. |
| `src-tauri/tests/chunk_reclaim_wiring.rs` | keep | Static pin that a refactor can drop a call site without failing unit tests. |
| `src-tauri/tests/cpu_policy_pin.rs` | keep | Static pin that a refactor can drop a call site without failing unit tests. |
| `src-tauri/tests/failure_commands_wiring.rs` | keep | Exclude fail-closed / skip-tolerant missing-drive postures. |
| `src-tauri/tests/live_lane_wiring.rs` | keep | Every `*_real_backend.rs` is a `cargo test --test` line in `e2e-live.yml`. |
| `src-tauri/tests/folder_restore_notify_wiring.rs` | keep | Static pin that a refactor can drop a call site without failing unit tests. |
| `src-tauri/tests/folder_share_wiring.rs` | keep | Static pin that a refactor can drop a call site without failing unit tests. |
| `src-tauri/tests/hcfs_contract.rs` | keep | Static pin that a refactor can drop a call site without failing unit tests. |
| `src-tauri/tests/keep_awake_wiring.rs` | keep | Static pin that a refactor can drop a call site without failing unit tests. |
| `src-tauri/tests/release_lane_pins.rs` | keep | Static pin that a refactor can drop a call site without failing unit tests. |
| `src-tauri/tests/scan_log_throttle_wiring.rs` | keep | Static pin that a refactor can drop a call site without failing unit tests. |
| `src-tauri/tests/shared_drive_wiring.rs` | keep | Static pin that a refactor can drop a call site without failing unit tests. |
| `src-tauri/tests/tray_panel_capability.rs` | keep | Static pin that a refactor can drop a call site without failing unit tests. |
| `src-tauri/tests/wallet_constant_drift.rs` | keep | Static pin that a refactor can drop a call site without failing unit tests. |

