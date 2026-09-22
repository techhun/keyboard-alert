package com.techhun.keyboardalert.restock;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
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
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public class MonitorService extends Service {
    static final String ACTION_STOP = "com.techhun.keyboardalert.restock.STOP";

    private static final String CHANNEL_MONITOR = "restock_monitor";
    private static final String CHANNEL_ALERT = "restock_alert";
    private static final String CHANNEL_STATUS = "restock_status";
    private static final int NOTIFICATION_MONITOR = 41001;
    private static final int NOTIFICATION_STATUS = 41002;
    private static final long RESULT_TIMEOUT_MS = 20_000L;
    private static final long NETWORK_RETRY_MS = 30_000L;
    private static final long MIN_PRODUCT_SPACING_MS = 1_000L;
    private static final long INITIAL_RATE_LIMIT_BACKOFF_MS = 30_000L;
    private static final long MAX_RATE_LIMIT_BACKOFF_MS = 5 * 60_000L;

    private enum Mode { BOOTSTRAP, DIRECT, DISCOVERY, SWAGKEY }

    private final Handler handler = new Handler(Looper.getMainLooper());
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

    private final Runnable resultTimeout = () -> {
        if (!awaitingResult || stopping) return;
        awaitingResult = false;
        markCurrentFailure("조회 시간 초과", "TIMEOUT");
        scheduleNextProduct();
    };

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        stopping = false;
        products = ProductStore.enabledList(this);
        DiagnosticLog.add(this, "SERVICE_START", null, products.length() + "개 알림");
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
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) settings.setSafeBrowsingEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString()
            .replace("; wv)", ")")
            .replace("Version/4.0 ", ""));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);

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

                if (mode == Mode.BOOTSTRAP && !bootstrapReady) {
                    bootstrapReady = true;
                    currentIndex = 0;
                    handler.postDelayed(MonitorService.this::checkCurrentProduct, 500L);
                } else if (mode == Mode.DISCOVERY) {
                    handler.postDelayed(MonitorService.this::runDiscoveryCheck, 700L);
                } else if (mode == Mode.SWAGKEY) {
                    handler.postDelayed(MonitorService.this::runSwagkeyCheck, 1200L);
                }
            }
        });
    }

    private void bootstrapSession() {
        products = ProductStore.enabledList(this);
        JSONObject first = products.optJSONObject(0);
        if (first == null) {
            stopSelf();
            return;
        }
        currentProduct = first;
        mode = Mode.BOOTSTRAP;
        bootstrapReady = false;
        webView.loadUrl(first.optString("url"));
    }

    private void checkCurrentProduct() {
        if (stopping || !bootstrapReady || awaitingResult) return;
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
            handler.postDelayed(this::checkCurrentProduct, NETWORK_RETRY_MS);
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

        if (!SiteSupport.isAllowedPage(SiteSupport.NAVER_SMARTSTORE, webView.getUrl())) {
            mode = Mode.DISCOVERY;
            webView.loadUrl(currentProduct.optString("url"));
            return;
        }

        String apiUrl = currentProduct.optString("apiUrl", "");
        if (apiUrl.isBlank()) {
            mode = Mode.DISCOVERY;
            webView.loadUrl(currentProduct.optString("url"));
            return;
        }

        mode = Mode.DIRECT;
        awaitingResult = true;
        handler.postDelayed(resultTimeout, RESULT_TIMEOUT_MS);
        webView.evaluateJavascript(InventoryApiScript.build(currentProduct), ignored -> {});
    }

    private void runDiscoveryCheck() {
        if (stopping || awaitingResult || currentProduct == null) return;
        JSONObject latest = ProductStore.find(this, currentProduct.optString("id"));
        if (latest == null || !latest.optBoolean("enabled", false)) {
            scheduleNextProduct();
            return;
        }
        currentProduct = latest;
        if (!SiteSupport.isProductPage(SiteSupport.NAVER_SMARTSTORE, webView.getUrl())) {
            markCurrentFailure("상품 페이지 확인 실패");
            scheduleNextProduct();
            return;
        }
        awaitingResult = true;
        handler.postDelayed(resultTimeout, RESULT_TIMEOUT_MS);
        webView.evaluateJavascript(InventoryScript.SCRIPT, ignored -> {});
    }

    private void runSwagkeyCheck() {
        if (stopping || awaitingResult || currentProduct == null) return;
        JSONObject latest = ProductStore.find(this, currentProduct.optString("id"));
        if (latest == null || !latest.optBoolean("enabled", false)) {
            scheduleNextProduct();
            return;
        }
        currentProduct = latest;
        if (!SiteSupport.isProductPage(SiteSupport.SWAGKEY_IMWEB, webView.getUrl())) {
            markCurrentFailure("SWAGKEY 상품 페이지 확인 실패");
            scheduleNextProduct();
            return;
        }
        awaitingResult = true;
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
        if (stopping) return;
        awaitingResult = false;
        handler.removeCallbacks(resultTimeout);
        if (currentProduct == null) {
            scheduleNextProduct();
            return;
        }

        JSONObject latest = ProductStore.find(this, currentProduct.optString("id"));
        if (latest == null || !latest.optBoolean("enabled", false)) {
            scheduleNextProduct();
            return;
        }
        currentProduct = latest;

        try {
            JSONObject result = new JSONObject(json);
            if (!result.optBoolean("ok", false)) {
                String error = result.optString("error", "UNKNOWN");
                int status = result.optInt("status", 0);
                if (SiteSupport.NAVER_SMARTSTORE.equals(currentSiteType())
                    && (status == 401 || status == 403)) {
                    invalidateSessionAndStop();
                    return;
                }

                if (status == 429) {
                    applyRateLimitBackoff();
                    scheduleNextProduct();
                    return;
                }

                if (SiteSupport.NAVER_SMARTSTORE.equals(currentSiteType()) && mode == Mode.DIRECT && (
                    "PRODUCT_API_FAILED".equals(error)
                        || "API_URL_MISSING".equals(error)
                        || status == 204
                        || status == 404
                )) {
                    currentProduct.put("apiUrl", "");
                    ProductStore.updateRuntime(this, currentProduct);
                    mode = Mode.DISCOVERY;
                    webView.loadUrl(currentProduct.optString("url"));
                    return;
                }

                String detail = status > 0 ? "조회 실패 · HTTP " + status : "조회 실패";
                markCurrentFailure(detail);
                scheduleNextProduct();
                return;
            }

            clearRateLimitBackoff();
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
            ProductStore.updateRuntime(this, currentProduct);
            scheduleNextProduct();
        } catch (Exception error) {
            markCurrentFailure("결과 처리 실패");
            scheduleNextProduct();
        }
    }

    private boolean processSuccessfulSnapshot(JSONObject product, JSONObject result) throws Exception {
        JSONArray selectedArray = product.optJSONArray("selectedIds");
        Set<String> selected = new HashSet<>();
        if (selectedArray != null) {
            for (int i = 0; i < selectedArray.length(); i++) selected.add(selectedArray.optString(i));
        }
        if (selected.isEmpty()) {
            markCurrentFailure("선택 옵션 없음");
            return false;
        }

        JSONObject configuredLabels = product.optJSONObject("selectedLabels");
        if (configuredLabels == null) configuredLabels = new JSONObject();

        JSONArray options = result.optJSONArray("options");
        if (options == null) options = new JSONArray();
        Map<String, Boolean> current = new HashMap<>();
        Map<String, String> currentLabels = new HashMap<>();
        int availableCount = 0;
        for (int i = 0; i < options.length(); i++) {
            JSONObject option = options.optJSONObject(i);
            if (option == null) continue;
            String id = option.optString("id", "");
            if (!selected.contains(id)) continue;
            boolean available = option.optBoolean("available", false);
            current.put(id, available);
            currentLabels.put(id, optionLabel(option));
            if (available) availableCount++;
        }

        // A successful HTTP response is not a verified inventory snapshot when
        // one or more configured options are missing. Preserve the last known
        // state instead of treating missing options as sold out.
        if (current.size() != selected.size()) {
            markCurrentFailure("선택 옵션 확인 실패");
            return false;
        }

        JSONObject previous = product.optJSONObject("lastAvailability");
        if (previous == null) previous = new JSONObject();
        JSONArray restocked = new JSONArray();
        for (String id : selected) {
            boolean now = current.getOrDefault(id, false);
            if (previous.has(id) && !previous.optBoolean(id, false) && now) {
                restocked.put(currentLabels.getOrDefault(id, configuredLabels.optString(id, id)));
            }
            previous.put(id, now);
        }

        String time = new SimpleDateFormat("HH:mm:ss", Locale.KOREA).format(new Date());
        product.put("lastAvailability", previous);
        product.put("lastStatus", "재고 있음 " + availableCount + "/" + selected.size() + " · " + time);
        product.put("lastCheck", System.currentTimeMillis());

        int enabledCount = ProductStore.enabledCount(this);
        MonitorPrefs.prefs(this).edit()
            .putString(MonitorPrefs.KEY_LAST_STATUS, enabledCount + "개 알림 켜짐")
            .putLong(MonitorPrefs.KEY_LAST_CHECK, System.currentTimeMillis())
            .apply();
        updateOngoingNotification(enabledCount + "개 알림 켜짐");
        DiagnosticLog.recordSuccess(this);

        if (restocked.length() > 0) {
            DiagnosticLog.recordRestock(this, product, restocked.toString());
            notifyRestock(product.optString("title", "재입고"), product.optString("url", ""), restocked);
        }
        return true;
    }

    private void applyRateLimitBackoff() {
        rateLimitBackoffMs = rateLimitBackoffMs <= 0
            ? INITIAL_RATE_LIMIT_BACKOFF_MS
            : Math.min(MAX_RATE_LIMIT_BACKOFF_MS, rateLimitBackoffMs * 2L);
        backoffUntil = System.currentTimeMillis() + rateLimitBackoffMs;
        long seconds = Math.max(1L, rateLimitBackoffMs / 1000L);
        markCurrentFailure("요청 제한 · " + seconds + "초 후 재시도", "RATE_LIMIT");
        updateOngoingNotification("요청 제한 · 잠시 후 다시 확인해요");
    }

    private void clearRateLimitBackoff() {
        rateLimitBackoffMs = 0L;
        backoffUntil = 0L;
    }

    private void invalidateSessionAndStop() {
        if (stopping) return;
        setStatus("로그인 필요");
        DiagnosticLog.add(this, "LOGIN_REQUIRED", currentProduct, "Naver 세션 만료");
        notifyLoginRequired();
        CookieManager cookies = CookieManager.getInstance();
        cookies.removeAllCookies(value -> cookies.flush());
        WebStorage.getInstance().deleteAllData();
        stopSelf();
    }

    private void markCurrentFailure(String message) {
        markCurrentFailure(message, "CHECK_FAIL");
    }

    private void markCurrentFailure(String message, String event) {
        if (currentProduct != null) {
            try {
                currentProduct.put("lastStatus", message);
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
        if (stopping) return;
        products = ProductStore.enabledList(this);
        if (products.length() == 0) {
            stopSelf();
            return;
        }
        currentIndex = (currentIndex + 1) % products.length();
        mode = Mode.DIRECT;
        long spacing = Math.max(
            MIN_PRODUCT_SPACING_MS,
            MonitorPrefs.intervalSeconds(this) * 1000L / Math.max(1, products.length())
        );
        long backoff = Math.max(0L, backoffUntil - System.currentTimeMillis());
        handler.postDelayed(this::checkCurrentProduct, Math.max(spacing, backoff));
    }

    private String optionLabel(JSONObject option) {
        StringBuilder label = new StringBuilder();
        for (String key : new String[]{"optionName1", "optionName2", "optionName3"}) {
            String value = option.optString(key, "");
            if (value.isBlank() || "null".equals(value)) continue;
            if (label.length() > 0) label.append(" / ");
            label.append(value);
        }
        return label.length() > 0 ? label.toString() : option.optString("id", "옵션");
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
            "재입고 알림",
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
