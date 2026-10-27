# NPay read-only delivery probe (v0.1.20)

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
- The original private NPay PKCS12 key remains in the user's private project Library as `npay-probe-signing-2026.p12` (created 2026-10-23), with the v0.1.14 APK retained for public-certificate fingerprint comparison. The key **must not** be committed to GitHub. The workflow now supports optional stable signing **only after the four NPay Actions Secrets are configured**; until then, GitHub only publishes a transient-key debug APK. A successful debug build does not prove persistent signing.

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

## 2026-10-27 v0.1.18 background feasibility pilot
- Source `.github/npay-probe/BackgroundProbeService.java` is copied into the **isolated NPay app only** during CI. The operational Restock `MonitorService`, manifest, and app are not changed.
- The user starts an explicit, one-shot background test from the NPay **진단** pane after logging in. Notification permission is requested on Android 13+; the probe runs in a short-lived foreground service with a 55-second bounded partial WakeLock and a 45-second timeout.
- The probe waits for `MainActivity.onPause` before requesting NPay shopping history in a separate, offscreen WebView, and checks again that the app is still offscreen when the result is returned. A foreground-only read must not be reported as background success.
- It reads **only shopping list page 1** (NPay `PAYMENT_LIST` entry) with previously established app WebView cookies. Only page item count / total page count or a small sanitized failure code are kept in private `SharedPreferences`. No order keys, tracking numbers, addresses, authentication secrets, or per-order records are stored/transmitted by this pilot.
- The service never auto-restarts, repeats, polls full order history, or accesses shipping details. It is intentionally not the final purchase synchronization or persistent background monitor.
- Test procedure: sign into NPay in the app, expand **진단**, tap **백그라운드 구매목록 1페이지 검증 (1회)**, immediately switch to the phone home screen or lock it, let the service finish, then open the NPay app and tap **백그라운드 결과 확인**. Record the exact success or sanitized failure message. A successful CI build does not prove the cookie/session or WebView behavior with the screen off.
- Before shipping beyond this pilot, confirm Android foreground-service use-case compliance (the specialUse subtype is subject to Google Play review) and choose appropriate scheduled/background execution constraints. The full 432-entry UI-driven scan has **not** been moved to the service.

## 2026-10-27 v0.1.19 full-history background list pilot
- User supplied an Android screenshot of the v0.1.18 **background one-page success**: 15 items on page 1; 29 total pages. It confirms a foreground service's offscreen WebView could read the authenticated listing with the app not foreground at the start and finish of that request. It does **not** verify 29 pages, shipping or a prolonged screen lock.
- New explicit diagnostic action: **백그라운드 전체 구매목록 검사 (1회)**. The existing one-page action remains for regression. The full-list action reuses the same service, navigates each page sequentially with a 1.5-second delay, validates page number / total page count and uses in-memory SHA-256 hashes of product order IDs to reject duplicate list entries and repeated pages. The raw IDs are not written to disk or exported.
- A bounded 300-second WakeLock and 280-second service timeout protect against unlimited background execution. The progress notification and local status include only page number, total list count, duplicate count or a sanitized failure reason. Stopping the service or exceeding safety bounds terminates the scan. No shipping-detail page is opened in this mode.
- Full-list success requires reaching every page **and** completing with the UI still in background; otherwise the report distinguishes a completed listing from fully-background verification. Page count changes or duplicate-only repeated pages stop conservatively.
- **Device test pending:** logged-in app → 진단 → 백그라운드 전체 구매목록 검사 (1회) → immediately go home / screen lock → later reopen → 백그라운드 결과 확인. Check that all pages were read and count matches the known list (earlier 432 items; live list may have changed). Ensure original full delivery scan, one-page background probe, login and export still work.
- This remains a list-only, read-only validation, **not** delivery detail retrieval or a production automatic sync. Persistent credentials, full order IDs, tracking numbers and DB writes are intentionally absent.

## Stable NPay signing (pending GitHub Secrets)
- Original v0.1.14 certificate SHA-256: `20fe05415645ecbc2debe2c872eff8d94efb2ac019492ba91668dfbf7da2c3d9`. This is a public certificate fingerprint, not a private key.
- Never use the Restock signing key for NPay. Never check in the PKCS12 or credentials, print a password to logs, or send passwords through chat.
- Configure repository **Settings → Secrets and variables → Actions** with exactly:
  - `NPAY_RELEASE_KEYSTORE_BASE64`: base64-encoded bytes of the original `npay-probe-signing-2026.p12`.
  - `NPAY_RELEASE_STORE_PASSWORD`: original PKCS12 password.
  - `NPAY_RELEASE_KEY_ALIAS`: original key alias.
  - `NPAY_RELEASE_KEY_PASSWORD`: original private-key password (normally identical to the store password for PKCS12).
- CI restores the keystore only into a temporary file, signs a separate `npay-v0.1.19-fixed-signed.apk` artifact, runs `apksigner verify`, and **fails** if its signing-certificate SHA-256 does not match v0.1.14. Debug APK remains a separate CI-only artifact; do not distribute it as a stable build.
- No repository-management tool in this chat has permission to set GitHub Actions Secrets. The password/alias and secret provisioning are currently unverified. Do **not** claim persistent signing is operational before a signed artifact is produced and verified.
- APKs v0.1.15–v0.1.19 already distributed were signed using different temporary debug certificates; they cannot update one another in place. After a one-time reinstall of a correctly fixed-signed build, future versions signed with the same P12 can update it.

## 2026-10-27 v0.1.20 background shipping sample (device test pending)
- Building on the **confirmed** v0.1.19 29/29-page, 433-item, zero-duplicate background shopping-list read, the app now includes **백그라운드 배송정보 시범 (최대 6건)** in diagnostics.
- It selects up to 6 well-formed shopping-list items with safe order-detail URLs from page 1, opens those detail pages in the service WebView, validates expected item presence, detects an explicit cancellation, and inspects **at most the first** valid delivery control per item. Existing v0.1.17 screen-probe JavaScript (`autoJs`, `clickControlJs`, `detailJs`) is reused, not reimplemented independently.
- Result counts distinguish shipment display candidates, explicit cancellations, no-control cases, and unbound/failed inspections. Nothing here confirms **per-item invoice linkage**, physical shipment identity, or delivery completion.
- The service keeps full keys and URLs **in process memory only** while running, with a conservative 215-second timeout, bounded 240-second partial WakeLock, and user-controlled stop. No full IDs, tracking numbers, addresses, cookies, or session credentials are written to persistent storage. Only aggregate counts/status are retained for post-run display.
- Both old one-page and full-list background modes are unchanged. Completion/failure/interruption now raises a separate user notification in the NPay app (notification permission permitting) linking back to the sanitized result status.
- Test **once**: log in; tap `진단` → `백그라운드 배송정보 시범 (최대 6건)`; immediately switch to home or lock screen. After notification, return and tap `백그라운드 결과 확인`. Confirm the exact success/partial reason, count, and whether phone stayed locked. A build/lint pass is **not** proof that shipment controls work in an offscreen WebView.
- Next decisions after verification: whether to move all shipping controls and per-item relations into a bounded background scan; incremental updates and secure local persistence require explicit design and are **not** implemented by v0.1.20.

## Rollback
- Last v0.1.16 source: commit `e67bf7f2541c4e1e40c772f9befae3a275d44bd8`.
- v0.1.17 changes were restricted to the dedicated NPay test workflow. v0.1.18 additionally introduces the separate NPay-only Java service and a manifest declaration generated by the isolated workflow. Restock is unchanged. There is no server or user database migration.
- Android downgrade may require uninstall due to signing and versionCode differences. Export required test reports before uninstall.
