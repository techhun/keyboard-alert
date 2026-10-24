# NPay read-only delivery probe (v0.1.17)

## Scope and isolation
- Prototype only; not a production courier-tracking or purchase-sync service.
- GitHub workflow: `.github/workflows/npay-readonly-probe.yml` on `test/npay-readonly-probe`.
- The workflow constructs a separate Android app with package ID `com.techhun.npayprobe` using the existing Android build scaffolding. The deployed Restock app, Keepodd and Notion data are not changed.
- The app reads NPay shopping-order pages through its authenticated WebView. It does not modify orders, synchronize external data, or automatically save/transmit the probe results.
- Exporting TXT / copying the report requires explicit user action. In-memory order URLs, keys and results are cleared when the app is destroyed.

## Limitations
- Items counted are entries in the currently accessible NPay shopping list, **not** proven unique orders or physical shipments.
- A delivery hit means that a carrier and masked tracking candidate were displayed. This **does not** prove a one-to-one association with the product-order key or that the shipment was actually delivered.
- Reports mask product order keys and tracking numbers to their last 4 characters. A matching suffix does not prove matching full tracking numbers.
- Kurly Next Mile suffix `0001` appeared across unrelated entries in a 2026-10-24 real-device report. v0.1.17 labels such results for verification rather than asserting that the number is invalid.
- Delivery buttons are **not skipped** within an order merely because masked output repeats. The report may compact repeated displays while keeping the physical button checks.
- In-memory resume works after a user-initiated pause within the same running app. The interrupted entry is restarted and its partial button counters are rolled back. Force-close, Android process death, explicit navigation to history, or a new scan resets this state. Cross-launch persistence is intentionally not implemented because the original probe should not automatically store user data.
- No fixed NPay signing key is configured in CI. GitHub's generated debug APK may carry a different certificate on subsequent CI runs, so an uninstall/reinstall may be required. A permanent update-signing process needs a separately managed private NPay key before routine distribution.

## Regression check / completion criteria
- CI on changes to `.github/workflows/npay-readonly-probe.yml`: Gradle `:app:lintDebug` and `:app:assembleDebug`. CI does **not** run NPay Android unit tests (the temporary project removes the inherited Restock test directory); successful CI is not a substitute for real-device verification.
- UI: login -> shopping history, full list discovery, full delivery scan, masked per-item report, clipboard and TXT export.
- Correctly distinguish explicit cancellation, carrier/tracking candidates, missing buttons, ambiguous extraction, failures and interrupted entries.
- Pause and resume with existing completed rows and correct button counters; new scan and app exit clear the in-memory state.
- Same-order cache reuse is identified separately and does not assert product-level proof.
- Never bypass the allowlisted NPay HTTPS origin, expose cookie/session details or automatically export full identifiers.
- Check real-device behavior on cases that previously returned empty shipping information, multi-button detail pages and Kurly Next Mile.

## 2026-10-24 v0.1.15 real-device baseline
- User stopped at completed entry 68 of 432 (69th entry partial); 44 shipping candidates, 21 explicit cancellations, 1 no-button result, 2 extra-review results, 0 failures.
- 114 buttons clicked, 12 more reused from previously verified same-order detail, 126 recognized in total. Runtime: 9m26s.
- Notable recheck targets: list entries 36, 39 and 49; list entry 64 exposed 20 buttons with the same masked Kurly suffix.
- v0.1.17 has passed CI build/lint but **has not** been smoke-tested on a device. It improves in-memory pause/resume accounting, report compaction, non-sensitive missing-result diagnostics and Kurly candidate annotation. Do not describe any Android UI behavior as verified until tested.

## Rollback
- Last v0.1.16 source: commit `e67bf7f2541c4e1e40c772f9befae3a275d44bd8`.
- v0.1.17 changes are restricted to the dedicated NPay test workflow and this document. Restoring the workflow to the previous commit reverts probe logic; there is no server or user database migration.
- Android downgrade may require uninstall due to signing and versionCode differences. Export required test reports before uninstall.
