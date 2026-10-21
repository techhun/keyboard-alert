package com.techhun.keyboardalert.restock;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public class MonitorService extends Service {
    static final String ACTION_STOP = "com.techhun.keyboardalert.restock.STOP";
    static final String ACTION_PAUSE_OPTION_LOOKUP = "com.techhun.keyboardalert.restock.PAUSE_OPTION_LOOKUP";
    static final String ACTION_RESUME_OPTION_LOOKUP = "com.techhun.keyboardalert.restock.RESUME_OPTION_LOOKUP";

    private static final String CHANNEL_MONITOR = "restock_monitor";
    private static final String CHANNEL_ALERT = "restock_alert";
    private static final String CHANNEL_STATUS = "restock_status";
    private static final int NOTIFICATION_MONITOR = 41001;
    private static final int NOTIFICATION_STATUS = 41002;
    private static final long RESULT_TIMEOUT_MS = 20_000L;
    private static final long NETWORK_RETRY_MS = 30_000L;
    private static final long MIN_PRODUCT_SPACING_MS = 5_000L;
    private static final long INITIAL_RATE_LIMIT_BACKOFF_MS = 30_000L;
    private static final long MAX_RATE_LIMIT_BACKOFF_MS = 30 * 60_000L;
    private static final int MAX_TRANSIENT_RETRIES = 2;
    private static final long TRANSIENT_RETRY_DELAY_MS = 5_000L;
    private static final long SMARTSTORE_INITIAL_SETTLE_MS = 1_200L;
    private static final long SMARTSTORE_PAGE_RECHECK_MS = 1_500L;
    private static final int SMARTSTORE_PAGE_PROBES_BEFORE_API = 2;
    private static final long NO_CONTENT_STORM_WINDOW_MS = 2 * 60_000L;
    private static final long NO_CONTENT_STORM_BACKOFF_MS = 5 * 60_000L;
    private static final int NO_CONTENT_STORM_DISTINCT_PRODUCTS = 3;
    private static final int NO_CONTENT_STORM_FAILURES = 3;
    private static final String KEY_BACKOFF_UNTIL = "smartstore_backoff_until";
    private static final String KEY_BACKOFF_MS = "smartstore_backoff_ms";
    private static final String KEY_BACKOFF_DEFER_FIX_MIGRATED = "smartstore_backoff_defer_fix_migrated_v1";

    private static void migrateSmartStoreRateLimitState(Context context) {
        var prefs = MonitorPrefs.prefs(context);
        if (prefs.getBoolean(KEY_BACKOFF_DEFER_FIX_MIGRATED, false)) return;
        prefs.edit()
            .remove(KEY_BACKOFF_UNTIL)
            .remove(KEY_BACKOFF_MS)
            .putBoolean(KEY_BACKOFF_DEFER_FIX_MIGRATED, true)
            .apply();
    }

    static long extendSmartStoreRateLimit(Context context, int status) {
        migrateSmartStoreRateLimitState(context);
        long now = System.currentTimeMillis();
        var prefs = MonitorPrefs.prefs(context);
        long until = prefs.getLong(KEY_BACKOFF_UNTIL, 0L);
        if (until > now) return until;

        long previous = prefs.getLong(KEY_BACKOFF_MS, 0L);
        long next = previous <= 0L
            ? (status == 204 ? 5 * 60_000L : INITIAL_RATE_LIMIT_BACKOFF_MS)
            : Math.min(MAX_RATE_LIMIT_BACKOFF_MS, previous * 2L);
        until = now + next;
        prefs.edit()
            .putLong(KEY_BACKOFF_UNTIL, until)
            .putLong(KEY_BACKOFF_MS, next)
            .apply();
        return until;
    }

    static long remainingSmartStoreRateLimitMillis(Context context) {
        migrateSmartStoreRateLimitState(context);
        long until = MonitorPrefs.prefs(context).getLong(KEY_BACKOFF_UNTIL, 0L);
        return Math.max(0L, until - System.currentTimeMillis());
    }

    private enum Mode { BOOTSTRAP, DIRECT, DISCOVERY, SWAGKEY }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable nextCheck = this::checkCurrentProduct;
    private final Runnable discoveryCheck = this::runDiscoveryCheck;
    private final Runnable swagkeyCheck = this::runSwagkeyCheck;
    private final Runnable bootstrapTask = this::bootstrapSession;
    private WebView webView;
    private PowerManager.WakeLock wakeLock;
    private JSONArray products = new JSONArray();
    private int currentIndex;
    private boolean awaitingResult;
    private boolean stopping;
    private boolean bootstrapReady;
    private Mode mode = Mode.BOOTSTRAP;
    private JSONObject currentProduct;
    private long rateLimitBackoffMs;
    private long backoffUntil;
    private boolean networkWaiting;
    private boolean pausedForOptionLookup;
    private boolean pageStateLogged;
    private int transientRetryCount;
    private int noContentReloadCount;
    private int smartStorePageProbeCount;
    private boolean noContentRecovery;
    private final Set<String> noContentStormProducts = new HashSet<>();
    private int noContentStormFailures;
    private long noContentStormWindowStartedAt;
    private long noContentBackoffUntil;

    private final Runnable resultTimeout = () -> {
        if (!awaitingResult || stopping || pausedForOptionLookup) return;
        awaitingResult = false;
        markCurrentFailure("조회 시간 초과", "TIMEOUT");
        scheduleNextProduct();
    };

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();
        migrateSmartStoreRateLimitState(this);
        backoffUntil = MonitorPrefs.prefs(this).getLong(KEY_BACKOFF_UNTIL, 0L);
        rateLimitBackoffMs = MonitorPrefs.prefs(this).getLong(KEY_BACKOFF_MS, 0L);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_PAUSE_OPTION_LOOKUP.equals(action)) {
            pausedForOptionLookup = true;
            awaitingResult = false;
            cancelPendingChecks();
            handler.removeCallbacks(resultTimeout);
            if (webView != null) webView.stopLoading();
            return START_STICKY;
        }
        if (ACTION_RESUME_OPTION_LOOKUP.equals(action)) {
            pausedForOptionLookup = false;
            if (ProductStore.enabledCount(this) <= 0) {
                stopSelf();
                return START_NOT_STICKY;
            }
            if (webView != null) {
                if (!bootstrapReady) {
                    bootstrapSession();
                } else {
                    backoffUntil = MonitorPrefs.prefs(this).getLong(KEY_BACKOFF_UNTIL, backoffUntil);
                    long rateBackoff = Math.max(0L, backoffUntil - System.currentTimeMillis());
        long noContentBackoff = Math.max(0L, noContentBackoffUntil - System.currentTimeMillis());
        long backoff = Math.max(rateBackoff, noContentBackoff);
                    scheduleNextCheck(Math.max(MIN_PRODUCT_SPACING_MS, backoff));
                }
                return START_STICKY;
            }
            // The service process may have been recreated while a manual lookup
            // was open. Fall through to the normal foreground startup path.
        }

        stopping = false;
        products = ProductStore.enabledList(this);
        if (products.length() == 0) {
            MonitorPrefs.setRunning(this, false);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!NotificationAccess.isAllowed(this)) {
            MonitorPrefs.updateStatus(this, "알림 권한 필요");
            MonitorPrefs.setRunning(this, false);
            stopSelf();
            return START_NOT_STICKY;
        }

        // A start request can arrive repeatedly when the UI resumes or a product
        // is toggled. If this process already owns the monitor WebView, refresh
        // lightweight state only and keep the single existing scheduler chain.
        if (webView != null) {
            updateOngoingNotification(products.length() + "개 알림 켜짐");
            return START_STICKY;
        }

        DiagnosticLog.add(this, "SERVICE_START", null, products.length() + "개 알림");
        MonitorPrefs.setRunning(this, true);
        getSystemService(NotificationManager.class).cancel(NOTIFICATION_STATUS);
        acquireWakeLock();
        Notification ongoing = buildOngoingNotification(products.length() + "개 알림 켜짐");
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(
                NOTIFICATION_MONITOR,
                ongoing,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST
            );
        } else {
            startForeground(NOTIFICATION_MONITOR, ongoing);
        }
        ensureWebView();

        if (!bootstrapReady) bootstrapSession();
        return START_STICKY;
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void ensureWebView() {
        if (webView != null) return;
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setLoadsImagesAutomatically(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        // Background monitoring intentionally bypasses cached product pages so
        // stock checks are based on fresh SmartStore page data.
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) settings.setSafeBrowsingEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString()
            .replace("; wv)", ")")
            .replace("Version/4.0 ", ""));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        SmartStorePageCapture.install(webView);

        webView.addJavascriptInterface(new RestockBridge(), "RestockBridge");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request == null || !request.isForMainFrame()) return false;
                return blockUntrustedNavigation(request.getUrl().toString());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return blockUntrustedNavigation(url);
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                if (stopping) return;
                String siteType = currentSiteType();
                if (SiteSupport.NAVER_SMARTSTORE.equals(siteType) && SiteSupport.isNaverLoginUrl(url)) {
                    setStatus("로그인 필요");
                    updateOngoingNotification("로그인이 필요해요");
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (stopping) return;
                String siteType = currentSiteType();
                if (SiteSupport.NAVER_SMARTSTORE.equals(siteType) && SiteSupport.isNaverLoginUrl(url)) {
                    invalidateSessionAndStop();
                    return;
                }
                if (!SiteSupport.isProductPage(siteType, url)) return;
                if (mode != Mode.DIRECT && currentProduct != null
                    && !SiteSupport.isSameProductPage(
                        siteType,
                        currentProduct.optString("url", ""),
                        url
                    )) {
                    DiagnosticLog.add(MonitorService.this, "STALE_PAGE", currentProduct, safeHost(url));
                    return;
                }

                if (pausedForOptionLookup) return;
                if (mode == Mode.BOOTSTRAP && !bootstrapReady) {
                    bootstrapReady = true;
                    currentIndex = 0;
                    scheduleNextCheck(500L);
                } else if (mode == Mode.DISCOVERY) {
                    handler.removeCallbacks(discoveryCheck);
                    handler.postDelayed(discoveryCheck, SMARTSTORE_INITIAL_SETTLE_MS);
                } else if (mode == Mode.SWAGKEY) {
                    handler.removeCallbacks(swagkeyCheck);
                    handler.postDelayed(swagkeyCheck, 1200L);
                }
            }
        });
    }

    private void bootstrapSession() {
        if (stopping || pausedForOptionLookup) return;
        products = ProductStore.enabledList(this);
        boolean usableNaverSession = SessionState.hasUsableNaverSession(this);
        JSONObject first = firstBootstrapProduct(products, usableNaverSession);
        if (first == null) {
            if (!usableNaverSession && !SessionState.isGuestMode(this)) {
                SessionState.markNaverAuthRequired(this);
                setStatus("로그인 필요");
                updateOngoingNotification("SmartStore 로그인이 필요해요");
                notifyLoginRequired();
                MonitorPrefs.setRunning(this, false);
            }
            stopSelf();
            return;
        }
        currentProduct = first;
        mode = Mode.BOOTSTRAP;
        bootstrapReady = false;
        webView.loadUrl(first.optString("url"));
    }

    private void checkCurrentProduct() {
        if (stopping || pausedForOptionLookup || !bootstrapReady || awaitingResult) return;
        products = ProductStore.enabledList(this);
        if (products.length() == 0) {
            stopSelf();
            return;
        }
        if (!NotificationAccess.isAllowed(this)) {
            setStatus("알림 권한 필요");
            stopSelf();
            return;
        }
        if (!isNetworkAvailable()) {
            setStatus("네트워크 연결 대기");
            updateOngoingNotification("네트워크 연결을 기다리는 중");
            if (!networkWaiting) {
                networkWaiting = true;
                DiagnosticLog.add(this, "NETWORK_WAIT", currentProduct, "네트워크 연결 없음");
            }
            scheduleNextCheck(NETWORK_RETRY_MS);
            return;
        }
        networkWaiting = false;
        if (currentIndex >= products.length()) currentIndex = 0;
        currentProduct = products.optJSONObject(currentIndex);
        if (currentProduct == null) {
            scheduleNextProduct();
            return;
        }

        String siteType = currentSiteType();
        if (shouldSkipForNaverSession(siteType, SessionState.hasUsableNaverSession(this))) {
            if (!SessionState.isGuestMode(this) && !SessionState.isNaverAuthRequired(this)) {
                SessionState.markNaverAuthRequired(this);
                setStatus("로그인 필요");
                DiagnosticLog.add(this, "LOGIN_REQUIRED", currentProduct, "Naver 세션 쿠키 없음");
                notifyLoginRequired();
            }
            scheduleNextProduct();
            return;
        }
        if (SiteSupport.NAVER_SMARTSTORE.equals(siteType)) {
            long noContentBackoff = Math.max(0L, noContentBackoffUntil - System.currentTimeMillis());
            if (noContentBackoff > 0L) {
                updateOngoingNotification("SmartStore 일시 오류 · 잠시 후 다시 확인해요");
                scheduleNextProduct();
                return;
            }
        }
        if (!SiteSupport.isSupportedProductUrl(currentProduct.optString("url", ""))) {
            markCurrentFailure("지원하지 않는 상품 주소");
            scheduleNextProduct();
            return;
        }

        if (SiteSupport.SWAGKEY_IMWEB.equals(siteType)) {
            mode = Mode.SWAGKEY;
            webView.loadUrl(currentProduct.optString("url"));
            return;
        }

        // Inspect a fresh SmartStore page state. The document-start capture keeps
        // the page's exact product API response in memory, so reusing the same
        // loaded page on later cycles would replay an old stock snapshot.
        mode = Mode.DISCOVERY;
        String currentProductId = currentProduct.optString("id", "");
        String loadedProductId = SiteSupport.productId(webView.getUrl());
        if (!shouldReloadSmartStorePage(
            currentProductId,
            loadedProductId,
            currentProduct.optLong("lastCheck", 0L)
        )) {
            runDiscoveryCheck();
            return;
        }
        webView.stopLoading();
        webView.loadUrl(currentProduct.optString("url"));
    }

    private void runDiscoveryCheck() {
        if (stopping || pausedForOptionLookup || mode != Mode.DISCOVERY || awaitingResult || currentProduct == null) return;
        JSONObject latest = ProductStore.find(this, currentProduct.optString("id"));
        if (latest == null || !latest.optBoolean("enabled", false)) {
            scheduleNextProduct();
            return;
        }
        currentProduct = latest;
        if (!SiteSupport.isSameProductPage(
            SiteSupport.NAVER_SMARTSTORE,
            currentProduct.optString("url", ""),
            webView.getUrl()
        )) {
            DiagnosticLog.add(this, "STALE_PAGE", currentProduct, safeHost(webView.getUrl()));
            webView.stopLoading();
            webView.loadUrl(currentProduct.optString("url"));
            return;
        }
        awaitingResult = true;
        handler.removeCallbacks(resultTimeout);
        handler.postDelayed(resultTimeout, RESULT_TIMEOUT_MS);

        long remainingBackoff = Math.max(0L, backoffUntil - System.currentTimeMillis());
        boolean allowApiFallback = allowSmartStoreApiFallback(
            smartStorePageProbeCount,
            noContentRecovery,
            remainingBackoff
        );
        if (smartStorePageProbeCount < SMARTSTORE_PAGE_PROBES_BEFORE_API) {
            smartStorePageProbeCount++;
        }
        webView.evaluateJavascript(
            InventoryScript.build(currentProduct, allowApiFallback),
            ignored -> {}
        );
    }

    private void runSwagkeyCheck() {
        if (stopping || pausedForOptionLookup || mode != Mode.SWAGKEY || awaitingResult || currentProduct == null) return;
        JSONObject latest = ProductStore.find(this, currentProduct.optString("id"));
        if (latest == null || !latest.optBoolean("enabled", false)) {
            scheduleNextProduct();
            return;
        }
        currentProduct = latest;
        if (!SiteSupport.isSameProductPage(
            SiteSupport.SWAGKEY_IMWEB,
            currentProduct.optString("url", ""),
            webView.getUrl()
        )) {
            DiagnosticLog.add(this, "STALE_PAGE", currentProduct, safeHost(webView.getUrl()));
            webView.stopLoading();
            webView.loadUrl(currentProduct.optString("url"));
            return;
        }
        awaitingResult = true;
        handler.removeCallbacks(resultTimeout);
        handler.postDelayed(resultTimeout, RESULT_TIMEOUT_MS);
        webView.evaluateJavascript(SwagkeyScript.SCRIPT, ignored -> {});
    }

    private class RestockBridge {
        @JavascriptInterface
        public void onResult(String json) {
            handler.post(() -> {
                if (currentProduct == null) return;
                String siteType = currentSiteType();
                if (!SiteSupport.isAllowedPage(siteType, webView == null ? null : webView.getUrl())) {
                    DiagnosticLog.recordBlockedNavigation(
                        MonitorService.this,
                        currentProduct,
                        safeHost(webView == null ? null : webView.getUrl())
                    );
                    return;
                }
                handleInventoryResult(json);
            });
        }
    }

    private void handleInventoryResult(String json) {
        if (stopping || pausedForOptionLookup || currentProduct == null) return;

        try {
            JSONObject result = new JSONObject(json);
            if (!isResultForCurrentProduct(result)) {
                DiagnosticLog.add(
                    this,
                    "STALE_RESULT",
                    currentProduct,
                    result.optString(
                        "productId",
                        result.optString("productNo", result.optString("pageUrl", "unknown"))
                    )
                );
                return;
            }

            awaitingResult = false;
            handler.removeCallbacks(resultTimeout);

            JSONObject latest = ProductStore.find(this, currentProduct.optString("id"));
            if (latest == null || !latest.optBoolean("enabled", false)) {
                scheduleNextProduct();
                return;
            }
            currentProduct = latest;
            if (!result.optBoolean("ok", false)) {
                String error = result.optString("error", "UNKNOWN");
                if ("NO_CONTENT".equals(error) || ("API_DEFERRED".equals(error) && noContentRecovery)) {
                    DiagnosticLog.add(this, "INVENTORY_DIAGNOSTIC", currentProduct,
                        (noContentRecovery ? "페이지 복구" : "API fallback") + " · "
                            + result.optString("pageDiagnostic", "정보 없음"));
                }
                int status = result.optInt("status", 0);
                if (SiteSupport.NAVER_SMARTSTORE.equals(currentSiteType())
                    && ("AUTH_REQUIRED".equals(error) || status == 401 || status == 403)) {
                    invalidateSessionAndStop();
                    return;
                }

                if ("API_DEFERRED".equals(error)) {
                    // PAGE_CAPTURE/PAGE_STATE is intentionally checked before
                    // the internal product API. Hidden background WebViews can
                    // finish navigation before SmartStore has populated product
                    // data, so give the same page one more settle window first.
                    if (SiteSupport.NAVER_SMARTSTORE.equals(currentSiteType())
                        && mode == Mode.DISCOVERY
                        && smartStorePageProbeCount < SMARTSTORE_PAGE_PROBES_BEFORE_API) {
                        handler.removeCallbacks(discoveryCheck);
                        handler.postDelayed(discoveryCheck, SMARTSTORE_PAGE_RECHECK_MS);
                        return;
                    }

                    if (SiteSupport.NAVER_SMARTSTORE.equals(currentSiteType())
                        && mode == Mode.DISCOVERY
                        && noContentRecovery) {
                        markCurrentFailure(
                            "204 후 페이지 복구 실패 · " + smartStorePageProbeCount + "회 확인",
                            "PAGE_RECOVERY_FAILED"
                        );
                        registerNoContentFailure();
                        scheduleNextProduct();
                        return;
                    }

                    long remainingBackoff = Math.max(0L, backoffUntil - System.currentTimeMillis());
                    if (SiteSupport.NAVER_SMARTSTORE.equals(currentSiteType())
                        && mode == Mode.DISCOVERY
                        && remainingBackoff <= 0L) {
                        // Two page-only probes completed. Run one final discovery
                        // pass with API fallback enabled.
                        handler.removeCallbacks(discoveryCheck);
                        handler.postDelayed(discoveryCheck, 250L);
                        return;
                    }

                    // No request was sent because a real 429 cooldown is active.
                    scheduleNextProduct();
                    return;
                }

                if ("NO_CONTENT".equals(error) || status == 204) {
                    if (SiteSupport.NAVER_SMARTSTORE.equals(currentSiteType())
                        && InventoryRetry.shouldReloadNoContent(error, status, noContentReloadCount)) {
                        noContentReloadCount++;
                        noContentRecovery = true;
                        smartStorePageProbeCount = 0;
                        DiagnosticLog.add(
                            this,
                            "NO_CONTENT_RETRY",
                            currentProduct,
                            "HTTP 204 · 페이지 재로드 후 1회 재확인"
                        );
                        handler.postDelayed(() -> {
                            if (stopping || pausedForOptionLookup || currentProduct == null) return;
                            webView.stopLoading();
                            webView.loadUrl(currentProduct.optString("url"));
                        }, 700L);
                        return;
                    }
                    markCurrentFailure("HTTP 204 · 상품 데이터 없음", "NO_CONTENT");
                    registerNoContentFailure();
                    scheduleNextProduct();
                    return;
                }

                if ("RATE_LIMITED".equals(error) || status == 429) {
                    applyRateLimitBackoff(status);
                    scheduleNextProduct();
                    return;
                }

                if (SiteSupport.NAVER_SMARTSTORE.equals(currentSiteType())
                    && mode == Mode.DIRECT
                    && InventoryRetry.shouldRediscoverDirect(error, status)) {
                    currentProduct.put("apiUrl", "");
                    ProductStore.updateRuntime(this, currentProduct);
                    transientRetryCount = 0;
                    mode = Mode.DISCOVERY;
                    webView.loadUrl(currentProduct.optString("url"));
                    return;
                }

                if ((mode == Mode.DISCOVERY || mode == Mode.SWAGKEY)
                    && InventoryRetry.shouldRetryMonitor(error, status)
                    && transientRetryCount < MAX_TRANSIENT_RETRIES) {
                    transientRetryCount++;
                    String retryDetail = error
                        + (status > 0 ? " · HTTP " + status : "")
                        + " · " + transientRetryCount + "/" + MAX_TRANSIENT_RETRIES;
                    DiagnosticLog.add(this, "CHECK_RETRY", currentProduct, retryDetail);
                    handler.postDelayed(this::retryCurrentCheck,
                        TRANSIENT_RETRY_DELAY_MS * transientRetryCount);
                    return;
                }

                String detail = status > 0 ? "조회 실패 · HTTP " + status : "조회 실패";
                markCurrentFailure(detail);
                scheduleNextProduct();
                return;
            }

            if (mode == Mode.DISCOVERY) {
                currentProduct.put("apiUrl", result.optString("apiUrl", ""));
                currentProduct.put("channelUid", result.optString("channelUid", ""));
                currentProduct.put("productNo", result.optString("productNo", ""));
            }
            if (!result.optString("title", "").isBlank()) {
                currentProduct.put("title", result.optString("title"));
            }

            if (!processSuccessfulSnapshot(currentProduct, result)) {
                scheduleNextProduct();
                return;
            }
            if (SiteSupport.NAVER_SMARTSTORE.equals(currentSiteType())) {
                clearRateLimitBackoff();
                clearNoContentStorm();
                getSystemService(NotificationManager.class).cancel(NOTIFICATION_STATUS);
                if (noContentRecovery) {
                    DiagnosticLog.add(
                        this,
                        "NO_CONTENT_RECOVERED",
                        currentProduct,
                        "페이지 재로드 후 " + result.optString("source", "PAGE_STATE") + "로 복구"
                    );
                }
            }
            if (SiteSupport.NAVER_SMARTSTORE.equals(currentSiteType()) && !pageStateLogged) {
                String source = result.optString("source", "");
                if ("PAGE_CAPTURE".equals(source)) {
                    pageStateLogged = true;
                    DiagnosticLog.add(this, "PAGE_CAPTURE_OK", currentProduct,
                        "페이지 상품 API 응답 재사용 · 선택 옵션 검증 성공");
                } else if ("PAGE_STATE".equals(source)) {
                    pageStateLogged = true;
                    DiagnosticLog.add(this, "PAGE_STATE_OK", currentProduct,
                        "선택 옵션까지 검증한 페이지 조회 성공");
                }
            }
            ProductStore.updateRuntime(this, currentProduct);
            scheduleNextProduct();
        } catch (Exception error) {
            markCurrentFailure("결과 처리 실패");
            scheduleNextProduct();
        }
    }

    private boolean isResultForCurrentProduct(JSONObject result) {
        return isResultForProduct(currentProduct, currentSiteType(), result);
    }

    static boolean isResultForProduct(JSONObject product, String siteType, JSONObject result) {
        if (product == null || result == null) return false;
        String currentId = product.optString("id", "");
        String resultProductId = result.optString("productId", "");
        if (resultProductId.isBlank()) resultProductId = result.optString("productNo", "");
        if (!resultProductId.isBlank()) return currentId.equals(resultProductId);

        String pageUrl = result.optString("pageUrl", "");
        if (!pageUrl.isBlank()) {
            return SiteSupport.isSameProductPage(siteType, product.optString("url", ""), pageUrl);
        }
        return false;
    }

    private void retryCurrentCheck() {
        if (stopping || pausedForOptionLookup || currentProduct == null) return;
        awaitingResult = false;
        handler.removeCallbacks(resultTimeout);
        if (mode == Mode.SWAGKEY) {
            if (!SiteSupport.isSameProductPage(
                SiteSupport.SWAGKEY_IMWEB,
                currentProduct.optString("url", ""),
                webView.getUrl()
            )) {
                webView.stopLoading();
                webView.loadUrl(currentProduct.optString("url"));
                return;
            }
            runSwagkeyCheck();
            return;
        }
        if (mode == Mode.DISCOVERY) {
            webView.stopLoading();
            webView.loadUrl(currentProduct.optString("url"));
        }
    }

    private boolean processSuccessfulSnapshot(JSONObject product, JSONObject result) throws Exception {
        JSONArray selectedArray = product.optJSONArray("selectedIds");
        if (selectedArray == null || selectedArray.length() == 0) {
            markCurrentFailure("선택 옵션 없음");
            return false;
        }

        JSONObject configuredLabels = product.optJSONObject("selectedLabels");
        if (configuredLabels == null) configuredLabels = new JSONObject();

        JSONArray options = result.optJSONArray("options");
        if (options == null) options = new JSONArray();
        OptionSelectionResolver.Resolution resolved = OptionSelectionResolver.resolve(
            selectedArray,
            configuredLabels,
            options
        );

        // A successful HTTP response is not a verified inventory snapshot when
        // one or more configured options are missing. Preserve the last known
        // state instead of treating missing options as sold out.
        if (!resolved.complete()) {
            markCurrentFailure(
                "선택 옵션 확인 실패 (" + resolved.availability.size() + "/" + resolved.requestedCount + ")"
            );
            return false;
        }

        JSONObject previous = product.optJSONObject("lastAvailability");
        if (previous == null) previous = new JSONObject();
        JSONObject previousQuantities = product.optJSONObject("lastStockQuantity");
        if (previousQuantities == null) previousQuantities = new JSONObject();
        JSONObject afterRestock = product.optJSONObject("lowStockAfterRestock");
        if (afterRestock == null) afterRestock = new JSONObject();

        for (Map.Entry<String, String> entry : resolved.oldToNew.entrySet()) {
            String oldId = entry.getKey();
            String newId = entry.getValue();
            if (oldId.equals(newId)) continue;
            if (previous.has(oldId) && !previous.has(newId)) {
                previous.put(newId, previous.optBoolean(oldId, false));
                previous.remove(oldId);
            }
            if (previousQuantities.has(oldId) && !previousQuantities.has(newId)) {
                previousQuantities.put(newId, previousQuantities.opt(oldId));
                previousQuantities.remove(oldId);
            }
            if (afterRestock.has(oldId) && !afterRestock.has(newId)) {
                afterRestock.put(newId, afterRestock.opt(oldId));
                afterRestock.remove(oldId);
            }
        }

        JSONArray restocked = new JSONArray();
        JSONArray restockDiagnostic = new JSONArray();
        JSONArray soldOut = new JSONArray();
        JSONArray soldOutDiagnostic = new JSONArray();
        JSONArray lowStock = new JSONArray();
        int threshold = MonitorPrefs.lowStockThreshold(this);
        int availableCount = 0;
        boolean smartStore = SiteSupport.NAVER_SMARTSTORE.equals(currentSiteType());
        for (Map.Entry<String, Boolean> entry : resolved.availability.entrySet()) {
            String id = entry.getKey();
            boolean now = entry.getValue();
            if (now) availableCount++;
            boolean hadPrevious = previous.has(id);
            boolean wasAvailable = hadPrevious && previous.optBoolean(id, false);
            boolean isRestocked = hadPrevious && !wasAvailable && now;
            boolean isSoldOut = hadPrevious && wasAvailable && !now;
            String optionLabel = resolved.labels.getOrDefault(id, id);
            Integer quantity = smartStore ? resolved.quantities.get(id) : null;
            if (isRestocked) {
                restocked.put(optionLabel);
                restockDiagnostic.put(optionLabel + " · "
                    + (quantity == null ? "수량 미확인" : quantity + "개"));
            }
            if (isSoldOut) {
                soldOut.put(optionLabel);
                soldOutDiagnostic.put(optionLabel + (quantity != null && quantity > 0
                    ? " · 구매 불가 (옵션 수량 " + quantity + "개)" : " · 0개"));
            }

            if (quantity != null) {
                Integer lastQuantity = previousQuantities.has(id) && !previousQuantities.isNull(id)
                    ? previousQuantities.optInt(id) : null;
                Integer restockQuantity = afterRestock.has(id) ? afterRestock.optInt(id) : null;
                if (now && LowStockAlert.shouldNotify(lastQuantity, quantity, threshold,
                    isRestocked, restockQuantity)) {
                    lowStock.put(resolved.labels.getOrDefault(id, id) + " · " + quantity + "개 남음");
                    afterRestock.remove(id);
                } else if (isRestocked && quantity > 0 && quantity <= threshold) {
                    afterRestock.put(id, quantity);
                } else if (quantity == 0 || quantity > threshold) {
                    afterRestock.remove(id);
                }
                previousQuantities.put(id, quantity);
            }
            previous.put(id, now);
        }

        if (resolved.migratedCount > 0) {
            product.put("selectedIds", resolved.selectedIds);
            product.put("selectedLabels", resolved.selectedLabels);
            DiagnosticLog.add(this, "OPTION_ID_MIGRATED", product,
                resolved.migratedCount + "개 옵션을 이름으로 다시 연결");
        }

        String time = new SimpleDateFormat("HH:mm:ss", Locale.KOREA).format(new Date());
        product.put("lastAvailability", previous);
        product.put("lastStockQuantity", previousQuantities);
        product.put("lowStockAfterRestock", afterRestock);
        product.put("lastStatus", inventoryStatusText(availableCount, resolved.requestedCount, time));
        product.put("lastCheck", System.currentTimeMillis());
        product.put("lastSuccess", product.optLong("lastCheck"));

        int enabledCount = ProductStore.enabledCount(this);
        MonitorPrefs.prefs(this).edit()
            .putString(MonitorPrefs.KEY_LAST_STATUS, enabledCount + "개 알림 켜짐")
            .putLong(MonitorPrefs.KEY_LAST_CHECK, System.currentTimeMillis())
            .apply();
        updateOngoingNotification(enabledCount + "개 알림 켜짐");
        DiagnosticLog.recordSuccess(this);

        String source = result.optString("source", "");
        if (restocked.length() > 0) {
            String detail = "상품상태=" + result.optString("statusType", "미확인") + " · " + restockDiagnostic.toString()
                + (source.isBlank() ? "" : " · " + source);
            DiagnosticLog.recordRestock(this, product, detail);
            notifyRestock(product.optString("title", "재입고"), product.optString("url", ""), restocked);
        }
        if (soldOut.length() > 0) {
            String detail = "상품상태=" + result.optString("statusType", "미확인") + " · " + soldOutDiagnostic.toString()
                + (source.isBlank() ? "" : " · " + source);
            DiagnosticLog.add(this, "SOLD_OUT", product, detail);
        }
        if (lowStock.length() > 0) {
            DiagnosticLog.add(this, "LOW_STOCK", product, lowStock.toString());
            notifyLowStock(product.optString("title", "상품"), product.optString("url", ""), lowStock);
        }
        return true;
    }

    static boolean shouldReloadSmartStorePage(String currentProductId, String loadedProductId, long lastCheck) {
        if (currentProductId == null || currentProductId.isBlank()) return true;
        if (!currentProductId.equals(loadedProductId)) return true;
        return lastCheck > 0L;
    }

    static String inventoryStatusText(int availableCount, int requestedCount, String time) {
        String availability = availableCount > 0 ? "재고 있음" : "재고 없음";
        return availability + " " + availableCount + "/" + requestedCount + " · " + time;
    }

    private void registerNoContentFailure() {
        if (currentProduct == null || !SiteSupport.NAVER_SMARTSTORE.equals(currentSiteType())) return;
        long now = System.currentTimeMillis();
        if (noContentStormWindowStartedAt <= 0L
            || now - noContentStormWindowStartedAt > NO_CONTENT_STORM_WINDOW_MS) {
            noContentStormWindowStartedAt = now;
            noContentStormProducts.clear();
            noContentStormFailures = 0;
        }
        String id = currentProduct.optString("id", "");
        if (!id.isBlank()) noContentStormProducts.add(id);
        noContentStormFailures++;

        if (shouldStartNoContentBackoff(
            noContentStormProducts.size(),
            noContentStormFailures,
            now - noContentStormWindowStartedAt
        )) {
            noContentBackoffUntil = now + NO_CONTENT_STORM_BACKOFF_MS;
            String detail = noContentStormFailures + "회 / "
                + noContentStormProducts.size()
                + "개 상품에서 HTTP 204 · 300초 보호 대기";
            DiagnosticLog.add(
                this,
                "NO_CONTENT_BACKOFF",
                currentProduct,
                detail
            );
            updateOngoingNotification("SmartStore 일시 오류 · 5분 후 다시 확인해요");
            notifySmartStoreDelayed();
            noContentStormProducts.clear();
            noContentStormFailures = 0;
            noContentStormWindowStartedAt = 0L;
        }
    }

    private void clearNoContentStorm() {
        noContentStormProducts.clear();
        noContentStormFailures = 0;
        noContentStormWindowStartedAt = 0L;
        if (noContentBackoffUntil <= System.currentTimeMillis()) {
            noContentBackoffUntil = 0L;
        }
    }

    static JSONObject firstBootstrapProduct(JSONArray products, boolean hasUsableNaverSession) {
        if (products == null) return null;
        for (int i = 0; i < products.length(); i++) {
            JSONObject product = products.optJSONObject(i);
            if (product == null) continue;
            String siteType = product.optString(
                "siteType",
                SiteSupport.detect(product.optString("url", ""))
            );
            if (!shouldSkipForNaverSession(siteType, hasUsableNaverSession)) return product;
        }
        return null;
    }

    static boolean shouldSkipForNaverSession(String siteType, boolean hasUsableNaverSession) {
        return SiteSupport.NAVER_SMARTSTORE.equals(siteType) && !hasUsableNaverSession;
    }

    static boolean shouldStartNoContentBackoff(
        int distinctProducts,
        int failureCount,
        long windowAgeMillis
    ) {
        return (distinctProducts >= NO_CONTENT_STORM_DISTINCT_PRODUCTS
                || failureCount >= NO_CONTENT_STORM_FAILURES)
            && windowAgeMillis >= 0L
            && windowAgeMillis <= NO_CONTENT_STORM_WINDOW_MS;
    }

    private void applyRateLimitBackoff(int status) {
        backoffUntil = extendSmartStoreRateLimit(this, status);
        rateLimitBackoffMs = MonitorPrefs.prefs(this).getLong(KEY_BACKOFF_MS, INITIAL_RATE_LIMIT_BACKOFF_MS);
        long seconds = Math.max(1L, (backoffUntil - System.currentTimeMillis() + 999L) / 1000L);
        String statusText = status > 0 ? "HTTP " + status + " · " : "";
        markCurrentFailure(statusText + "요청 제한 · " + seconds + "초 후 재시도", "RATE_LIMIT");
        updateOngoingNotification("요청 제한 · 잠시 후 다시 확인해요");
    }

    private void clearRateLimitBackoff() {
        rateLimitBackoffMs = 0L;
        backoffUntil = 0L;
        MonitorPrefs.prefs(this).edit()
            .remove(KEY_BACKOFF_UNTIL)
            .remove(KEY_BACKOFF_MS)
            .apply();
    }

    private void invalidateSessionAndStop() {
        if (stopping) return;
        SessionState.markNaverAuthRequired(this);
        setStatus("로그인 필요");
        DiagnosticLog.add(this, "LOGIN_REQUIRED", currentProduct, "Naver 세션 만료");
        notifyLoginRequired();
        CookieManager cookies = CookieManager.getInstance();
        cookies.removeAllCookies(value -> cookies.flush());
        WebStorage.getInstance().deleteAllData();

        products = ProductStore.enabledList(this);
        if (products.length() == 0) {
            stopSelf();
            return;
        }

        updateOngoingNotification(products.length() + "개 알림 켜짐");
        bootstrapReady = false;
        currentIndex = 0;
        currentProduct = null;
        handler.removeCallbacks(bootstrapTask);
        handler.postDelayed(bootstrapTask, 500L);
    }

    private void markCurrentFailure(String message) {
        markCurrentFailure(message, "CHECK_FAIL");
    }

    private void markCurrentFailure(String message, String event) {
        if (currentProduct != null) {
            try {
                String lastSuccessText = currentProduct.optLong("lastSuccess", 0L) > 0L
                    ? new SimpleDateFormat("HH:mm:ss", Locale.KOREA).format(new Date(currentProduct.optLong("lastSuccess")))
                    : "시각 미기록";
                JSONObject lastAvailability = currentProduct.optJSONObject("lastAvailability");
                boolean hasPreviousStock = lastAvailability != null && lastAvailability.length() > 0;
                currentProduct.put("lastStatus", hasPreviousStock
                    ? message + " · 이전 재고 보존 (" + lastSuccessText + ")" : message);
                currentProduct.put("lastCheck", System.currentTimeMillis());
                ProductStore.updateRuntime(this, currentProduct);
            } catch (Exception ignored) {}
        }
        if ("TIMEOUT".equals(event)) {
            DiagnosticLog.recordTimeout(this, currentProduct);
        } else if ("RATE_LIMIT".equals(event)) {
            DiagnosticLog.recordRateLimit(this, currentProduct, message);
        } else {
            DiagnosticLog.recordFailure(this, event, currentProduct, message);
        }
        setStatus(message);
    }

    private void scheduleNextProduct() {
        if (stopping || pausedForOptionLookup) return;
        transientRetryCount = 0;
        noContentReloadCount = 0;
        smartStorePageProbeCount = 0;
        noContentRecovery = false;
        products = ProductStore.enabledList(this);
        if (products.length() == 0) {
            stopSelf();
            return;
        }
        currentIndex = (currentIndex + 1) % products.length();
        long backoff = Math.max(0L, backoffUntil - System.currentTimeMillis());
        if (backoff > 0L) {
            for (int i = 0; i < products.length(); i++) {
                JSONObject candidate = products.optJSONObject(currentIndex);
                if (candidate != null && SiteSupport.SWAGKEY_IMWEB.equals(
                    SiteSupport.detect(candidate.optString("url", "")))) break;
                currentIndex = (currentIndex + 1) % products.length();
            }
        }
        mode = Mode.DIRECT;
        long spacing = productSpacingMillis(
            MonitorPrefs.intervalSeconds(this),
            products.length()
        );
        JSONObject next = products.optJSONObject(currentIndex);
        boolean smartStoreNext = next != null && SiteSupport.NAVER_SMARTSTORE.equals(
            SiteSupport.detect(next.optString("url", "")));
        cancelModeCallbacks();
        scheduleNextCheck(smartStoreNext ? Math.max(spacing, backoff) : spacing);
    }

    static boolean allowSmartStoreApiFallback(
        int pageProbeCount,
        boolean noContentRecovery,
        long remainingBackoffMillis
    ) {
        return pageProbeCount >= SMARTSTORE_PAGE_PROBES_BEFORE_API
            && !noContentRecovery
            && remainingBackoffMillis <= 0L;
    }

    static long productSpacingMillis(int intervalSeconds, int productCount) {
        long configured = Math.max(1, intervalSeconds) * 1000L / Math.max(1, productCount);
        return Math.max(MIN_PRODUCT_SPACING_MS, configured);
    }

    private void scheduleNextCheck(long delayMs) {
        handler.removeCallbacks(nextCheck);
        handler.postDelayed(nextCheck, Math.max(0L, delayMs));
    }

    private void cancelModeCallbacks() {
        handler.removeCallbacks(discoveryCheck);
        handler.removeCallbacks(swagkeyCheck);
        handler.removeCallbacks(bootstrapTask);
    }

    private void cancelPendingChecks() {
        handler.removeCallbacks(nextCheck);
        cancelModeCallbacks();
    }

    private String currentSiteType() {
        if (currentProduct == null) return SiteSupport.UNKNOWN;
        String siteType = currentProduct.optString("siteType", "");
        if (siteType.isBlank() || SiteSupport.UNKNOWN.equals(siteType)) {
            siteType = SiteSupport.detect(currentProduct.optString("url", ""));
        }
        return siteType;
    }

    private boolean blockUntrustedNavigation(String url) {
        if (currentProduct == null || url == null || url.isBlank()) return false;
        String siteType = currentSiteType();
        if (SiteSupport.NAVER_SMARTSTORE.equals(siteType) && SiteSupport.isNaverLoginUrl(url)) return false;
        if (SiteSupport.isAllowedPage(siteType, url)) return false;
        DiagnosticLog.recordBlockedNavigation(this, currentProduct, safeHost(url));
        return true;
    }

    private String safeHost(String url) {
        try {
            String host = Uri.parse(url == null ? "" : url).getHost();
            return host == null ? "unknown" : host;
        } catch (Exception ignored) {
            return "unknown";
        }
    }

    private void setStatus(String status) {
        MonitorPrefs.updateStatus(this, status);
    }

    private boolean isNetworkAvailable() {
        ConnectivityManager manager =
            (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (manager == null) return true;
        Network network = manager.getActiveNetwork();
        if (network == null) return false;
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
        return capabilities != null
            && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "restock:monitor");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
    }

    private void createNotificationChannels() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel monitor = new NotificationChannel(
            CHANNEL_MONITOR,
            "재입고 알림 상태",
            NotificationManager.IMPORTANCE_LOW
        );
        manager.createNotificationChannel(monitor);

        NotificationChannel alert = new NotificationChannel(
            CHANNEL_ALERT,
            "재고 알림",
            NotificationManager.IMPORTANCE_HIGH
        );
        alert.enableVibration(true);
        manager.createNotificationChannel(alert);

        NotificationChannel status = new NotificationChannel(
            CHANNEL_STATUS,
            "Restock 상태 알림",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        manager.createNotificationChannel(status);
    }

    private PendingIntent openAppIntent() {
        Intent intent = new Intent(this, GateActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private Notification buildOngoingNotification(String text) {
        return new Notification.Builder(this, CHANNEL_MONITOR)
            .setSmallIcon(android.R.drawable.ic_popup_sync)
            .setContentTitle("Restock")
            .setContentText(text)
            .setContentIntent(openAppIntent())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build();
    }

    private void updateOngoingNotification(String text) {
        getSystemService(NotificationManager.class).notify(
            NOTIFICATION_MONITOR,
            buildOngoingNotification(text)
        );
    }

    private void notifySmartStoreDelayed() {
        Notification notification = new Notification.Builder(this, CHANNEL_STATUS)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle("Restock · SmartStore 조회 지연")
            .setContentText("일시적인 응답 오류로 5분 후 자동 재시도해요.")
            .setContentIntent(openAppIntent())
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_STATUS)
            .build();
        getSystemService(NotificationManager.class).notify(NOTIFICATION_STATUS, notification);
    }

    private void notifyLoginRequired() {
        Notification notification = new Notification.Builder(this, CHANNEL_STATUS)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle("Restock · 로그인 필요")
            .setContentText("재입고 감시를 계속하려면 다시 로그인해주세요.")
            .setContentIntent(openAppIntent())
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_STATUS)
            .build();
        getSystemService(NotificationManager.class).notify(NOTIFICATION_STATUS, notification);
    }

    private void notifyRestock(String title, String productUrl, JSONArray labels) {
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < labels.length(); i++) {
            if (i > 0) text.append(" · ");
            text.append(labels.optString(i));
        }

        Intent open = productUrl == null || productUrl.isBlank()
            ? new Intent(this, GateActivity.class)
            : new Intent(Intent.ACTION_VIEW, Uri.parse(productUrl));
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            Math.abs((title + productUrl).hashCode()),
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification notification = new Notification.Builder(this, CHANNEL_ALERT)
            .setSmallIcon(android.R.drawable.stat_notify_more)
            .setContentTitle("📦 재입고 · " + title)
            .setContentText(text.toString())
            .setStyle(new Notification.BigTextStyle().bigText(text.toString()))
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .setDefaults(Notification.DEFAULT_ALL)
            .setCategory(Notification.CATEGORY_EVENT)
            .build();
        getSystemService(NotificationManager.class).notify(
            42000 + Math.abs((title + text).hashCode() % 1000),
            notification
        );
    }

    private void notifyLowStock(String title, String productUrl, JSONArray labels) {
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < labels.length(); i++) {
            if (i > 0) text.append(" · ");
            text.append(labels.optString(i));
        }

        Intent open = productUrl == null || productUrl.isBlank()
            ? new Intent(this, GateActivity.class)
            : new Intent(Intent.ACTION_VIEW, Uri.parse(productUrl));
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            Math.abs(("low-stock:" + productUrl).hashCode()),
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification notification = new Notification.Builder(this, CHANNEL_ALERT)
            .setSmallIcon(android.R.drawable.stat_notify_more)
            .setContentTitle("⚠️ 재고 부족 · " + title)
            .setContentText(text.toString())
            .setStyle(new Notification.BigTextStyle().bigText(text.toString()))
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .setDefaults(Notification.DEFAULT_ALL)
            .setCategory(Notification.CATEGORY_EVENT)
            .build();
        getSystemService(NotificationManager.class).notify(
            43000 + Math.abs(productUrl.hashCode() % 1000),
            notification
        );
    }

    @Override
    public void onDestroy() {
        stopping = true;
        awaitingResult = false;
        handler.removeCallbacksAndMessages(null);
        MonitorPrefs.setRunning(this, false);
        if (webView != null) {
            webView.removeJavascriptInterface("RestockBridge");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        DiagnosticLog.add(this, "SERVICE_STOP", currentProduct, null);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
