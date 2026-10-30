# NPay read-only delivery probe (v0.1.24)

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

## 2026-10-27 v0.1.21 multi-control background probe (device test pending)
- The v0.1.20 **actual phone** report showed **6/6 sampled entries** with **6 shipping-detail display hits**, **6 direct clicks**, **0 cancelled**, **0 missing buttons**, and **0 additional-review cases**, plus "백그라운드 실행 확인". This proves the first shipping-control WebView flow works while the app is backgrounded; it does not prove item-level invoice linkage or all delivery buttons in a bundled order.
- New opt-in **백그라운드 묶음배송 버튼 검사 (6건·건당 최대 3개)** tests up to the first **three** stable, recognized shipping controls per one of six bounded list entries. Each following button is inspected only after reopening the original detail page, rechecking the expected product order and full button signature, and independently clicking that button. Stop conservatively if keys, item state or page change.
- Per-run counters include total list entries inspected, shipping display hits (entry-level and button-level), number of entries with multiple recognized buttons, direct button clicks, known control count, and buttons left **unverified**. Entries with untested controls or any inconclusive checked control are classified as **additional review**, never fully verified shipment matches. This never asserts that identical masked carrier/tail values prove identical parcels.
- Keep the one-button six-item mode, single-page mode, all-shopping-pages mode, explicit stop and completion notification for regression.
- **Real-device test pending**: log in; select the new multi-control button; switch to home or lock; read the completion notification / `백그라운드 결과 확인`. Check that multi-button orders and button counts are reported and no untested buttons are silently claimed as successful. This is still an inspection-only probe, not all-orders delivery sync or persistent shipping tracking.

## 2026-10-28 v0.1.21 field result and v0.1.22 follow-up
- v0.1.21 real-device background multi-button test: completed **6/6** sampled list items, **5** fully verified display hits, **1** extra-review item, **10** direct button clicks with **10** visible carrier/tracking candidates, **11** buttons discovered, **1** unverified, **3** entries with multiple buttons. No cancellation or no-button cases. The app explicitly reported **background execution confirmed**.
- The report alone does **not** uniquely identify why that one button was unverified. Inspection of v0.1.21 code shows a deliberately conservative **3 buttons per entry** cap, which can produce this exact outcome for a four-control detail page; a changed control signature, click/poll failure, or timeout could also produce one unverified button.
- v0.1.22 expands the per-entry bound to **five** controls (keeping the overall 6-entry sample), adds a stable **55-second per-entry watchdog** independent of button index/reload, and stores only sanitized item-position and reason strings (e.g. `3번:건당 5개 검사 한도`). The former "미검사" count is now labeled **"미확인"**, because a clicked control without matching delivery display is not fully verified.
- Do not infer identical parcels or item-level invoice assignment from repeated carrier/tracking tails. Preserve the old one-button background mode, 1-page and 29-page list modes, explicit stop, and on-device completion notification for regression.
- **v0.1.22 CI build/lint and actual phone validation are separate milestones.** Do not mark its user-visible behavior as complete before the next real-device observation.

## 2026-10-28 v0.1.22 phone result and v0.1.23 follow-up
- v0.1.22 phone screenshot: **6/6** entries inspected, **5** entry-level delivery display candidates, **1** entry with no visible shipping button, **0** ambiguous/unknown entries, **9** controls found/clicked with **9** delivery displays, **0** unverified controls, **2** entries with multiple buttons. UI reported `백그라운드 실행 확인`.
- Compared with v0.1.21's **11** controls across **3** multi-button entries, v0.1.22 discovered **9** across **2**. This may reflect changing order-list composition, loading differences or real order state, not necessarily a fixed regression. Both tests only sample the current first six items. Do not assume they are exactly the same orders without the full IDs (which are intentionally not exported).
- Code review showed the v0.1.22 sample immediately classified `controlKeys.length==0` as "no shipping button" on the **first** detail DOM snapshot. In v0.1.23 it checks the same scoped product order **four times** (1.3 seconds apart) before classifying no visible button. If a control appears late, scanning continues and a non-sensitive delayed-control counter is recorded. If it stays absent, the aggregate report records just the **list position**, not product/order identifiers.
- v0.1.23 also adds progress metadata for number of empty-control retries, protects against a stale persistent `running` flag when Android kills the foreground service, and preserves the original read-only / offscreen / bounded run behavior.
- Validation is required before marking reliable zero-control classification complete. If a specific order legitimately has no shipping button, a stable zero result is expected, but is **not** evidence of no physical shipment or missing tracking information.

## APK distribution links and Android download reliability (2026-10-28)
- ChatGPT-hosted `sandbox:/mnt/data/...` file links have intermittently failed with `Library not found` in the user's Android app despite valid APK files. **Do not rely on these links as the sole distribution channel.**
- GitHub Actions for the NPay test branch now publishes its lint/build-verified, **temporary debug-signed** APK to a **public GitHub prerelease** after the CI run. Versioned assets remain available outside the ChatGPT Library and do not depend on expiring seven-day Actions artifacts.
- v0.1.23 stable direct asset: `https://github.com/techhun/keyboard-alert/releases/download/npay-probe-v0.1.23/NPay-Probe-v0.1.23-debug.apk`. GitHub Release page: `https://github.com/techhun/keyboard-alert/releases/tag/npay-probe-v0.1.23`.
- At publication the GitHub API verified an uploaded asset of **984,848 bytes** with SHA-256 digest `6db3611b8f8f86cecc12a1fbe95d513b9e8177059e3cd38bf12a9dcb1039b779`. CI execution: `https://github.com/techhun/keyboard-alert/actions/runs/40610967334`.
- The prerelease APK is **publicly downloadable** (the source repository is public) and remains a test-only build with an ephemeral debug signing certificate. This is **not** a fix for the persistent NPay P12 signing key. The dedicated fixed-signing workflow still requires Actions Secrets; do not promise APK in-place update before verifying the certificate.
- Future NPay versions derive their own versioned tag and filename from the generated Android `versionName`, and the CI workflow publishes a corresponding GitHub prerelease asset after passing lint/build.

## 2026-10-28 v0.1.23 phone result and v0.1.24 first-page scale probe
- v0.1.23 real-phone report: **6/6** inspected, **6/6** with visible delivery information, **11/11** shipping controls clicked and displayed, **3** multi-control entries, **0** missing controls, **0** extra-review entries, **0** unverified controls, **0** delayed-control recoveries. User screenshot explicitly reports `백그라운드 실행 확인`. This improves on v0.1.21 and v0.1.22 sample reports but does not establish per-item invoice association across bundled orders.
- v0.1.24 adds a **separate explicit opt-in** diagnostic `백그라운드 첫 페이지 배송검사 (최대 15건)`, reusing the exact validated detail-page scanner and conservative per-item limit of **five** controls. It is intended to reveal scaling, slow pages, ambiguous groupings and count gaps without embarking on all **433** known list entries. The original 6-item, 1-page list, 29-page full-list and on-screen modes remain.
- A bounded **12-minute** end-to-end timeout and **12m40s** capped wake lock protect the handset; an existing 55-second per-item timeout, stop button and status/notification apply. The full-sample service does not persist raw product order keys, tracking numbers or URLs, and does not send data automatically. Note: this test may consume more battery and network traffic than the six-item trial.
- Status now includes only aggregate counts, shared order-detail URL count, elapsed seconds and **non-sensitive** list position/reason codes. A shared detail URL is diagnostic only; it does **not** prove a shared physical shipment. More than five recognized controls for one entry still yields additional-review status rather than a false success.
- **Test pending**: install from a verified GitHub v0.1.24 prerelease asset, login, `진단 → 백그라운드 첫 페이지 배송검사 (최대 15건)`, immediately go home/lock, and check the final notification and in-app status. Compare completed entries, found/clicked/displayed/unknown counts and actual elapsed time. Only after this stage consider bounded subsequent pages/incremental persistence. Do not claim the 433-item shipment scan works.
- No operational Restock, Keepodd, external database or notification service code changed.

## 2026-10-30 fixed-key delivery protection
- Verified the preserved `npay-readonly-probe-v0.1.14.apk` using the local Android `apksigner` tool. Its v3 certificate SHA-256 is `20fe05415645ecbc2debe2c872eff8d94efb2ac019492ba91668dfbf7da2c3d9`, agreeing with the pinned value. The public v0.1.23 CI debug APK's v2 certificate SHA-256 is `08bd1101f9829306e31825f0362c3d546118a1b6c8c5d956ba876d8f58cdc321`, and therefore **cannot** upgrade a v0.1.14-fixed-signed install or vice versa without an uninstall.
- The 3,472-byte `npay-probe-signing-2026.p12` is present in the private user Library, is a valid ASN.1 PKCS12 container, and requires a nonempty password. The previous signing-key password and alias were **not** recorded in retrievable earlier work, so this chat cannot unlock the retained private key or sign a new APK yet.
- To prevent repeating temporary signatures as downloads, the NPay CI workflow is now **fail-closed for public release**: it always performs Android lint/build, but a public GitHub prerelease is created **only** after all four Actions Secrets are provided, the P12 signs the output, and the final APK certificate matches the pinned v0.1.14 fingerprint. Without the four Secrets, the job keeps CI artifacts internal and skips the release step. Any partially configured Secrets fail the job.
- Release tag for an authenticated package is `npay-probe-v<version>-fixed` with an asset ending `fixed-signed.apk`. Never distribute the `app-debug.apk` as an update-installable APK. Previously published `npay-probe-v0.1.24` was a debug-signed test release and remains historical, **not** an updatable fixed-key release.
- Exactly once, the user must enter the original PKCS12 password/alias into GitHub Secrets **without sharing credentials in ChatGPT**. If the original password cannot be recovered, generating a **new dedicated fixed signing key** is a separate procedure requiring a deliberate fingerprint baseline update, safe off-repository backup, and a one-time migration install; no new key has been generated in this change.
- As the latest v0.1.24 installed build carries a temporary debug certificate, it cannot be upgraded in place to a fixed-signing APK. Following the one-time uninstall/install, future releases with the same signing certificate and incrementing Android versionCode are eligible for in-place updates.

## Rollback
- Last v0.1.16 source: commit `e67bf7f2541c4e1e40c772f9befae3a275d44bd8`.
- v0.1.17 changes were restricted to the dedicated NPay test workflow. v0.1.18 additionally introduces the separate NPay-only Java service and a manifest declaration generated by the isolated workflow. Restock is unchanged. There is no server or user database migration.
- Android downgrade may require uninstall due to signing and versionCode differences. Export required test reports before uninstall.
