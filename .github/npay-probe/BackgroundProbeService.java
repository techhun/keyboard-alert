package com.techhun.keyboardalert.restock;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Read-only, user-initiated, single-page background service feasibility check.
 * Only aggregate counts and non-sensitive status text are saved locally.
 * No product/order IDs, tracking numbers or login details are stored/exported.
 * Never automatically repeats or starts on reboot.
 */
public final class BackgroundProbeService extends Service {
    static final String ACTION_STOP = "com.techhun.npayprobe.BG_STOP";
    static final String PREFS = "npay_bg_probe";
    static final String STATUS = "status";
    private static final int NOTIFICATION_ID = 62018;
    private static final String CHANNEL = "npay_bg_probe";
    private static final String URL = "https://pay.naver.com/pc/history?page=1&serviceChannel=SHOPPING";
    private static final String PAGE_JS = "(function(){try{if(location.origin!=='https://pay.naver.com'||!/^\/(?:pc\/)?history\/?$/.test(location.pathname))return JSON.stringify({ok:false,code:'NOT_HISTORY'});var el=document.getElementById('__NEXT_DATA__');if(!el)return JSON.stringify({ok:false,code:'WAIT'});if(el.textContent.length>5000000)return JSON.stringify({ok:false,code:'LIMIT'});var d=JSON.parse(el.textContent),q=d&&d.props&&d.props.pageProps&&d.props.pageProps.dehydratedState&&d.props.pageProps.dehydratedState.queries;if(!Array.isArray(q))return JSON.stringify({ok:false,code:'WAIT'});var p=null;for(var i=0;i<q.length;i++){if(Array.isArray(q[i].queryKey)&&q[i].queryKey[0]==='PAYMENT_LIST'){var pages=q[i].state&&q[i].state.data&&q[i].state.data.pages;if(Array.isArray(pages))for(var j=0;j<pages.length;j++)if(Number(pages[j].curPage)===1){p=pages[j];break;}if(p)break;}}if(!p)return JSON.stringify({ok:false,code:'WAIT'});var count=Array.isArray(p.items)?p.items.length:-1,total=Number(p.totalPage);if(count<0||count>1000||!Number.isInteger(total)||total<0||total>500)return JSON.stringify({ok:false,code:'BAD_DATA'});return JSON.stringify({ok:true,count:count,pages:total});}catch(_){return JSON.stringify({ok:false,code:'PARSE'});}})()";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView webView;
    private PowerManager.WakeLock wakeLock;
    private boolean started = false, finished = false;
    private int attempt = 0;

    @Override public void onCreate() {
        super.onCreate();
        NotificationChannel channel = new NotificationChannel(
            CHANNEL, "NPay 일회성 조회 검증", NotificationManager.IMPORTANCE_LOW);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            finish("사용자 중지 · 백그라운드 조회 종료");
            return START_NOT_STICKY;
        }
        if (started) return START_NOT_STICKY;
        started = true;
        try {
            Notification notification = notification("화면 전환 후 8초 뒤 구매목록 1페이지 검사");
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "npay:onepage-probe");
            wakeLock.acquire(55000L); // bounded; unlike Restock's persistent monitor
            status("조회 대기 중 · 화면을 꺼도 테스트 진행");
            handler.postDelayed(this::begin, 8000L);
            handler.postDelayed(() -> finish("시간 초과 · 백그라운드 화면 응답 없음"), 45000L);
        } catch (RuntimeException ex) {
            finish("서비스 시작 실패 · Android 백그라운드 실행 제한");
        }
        return START_NOT_STICKY;
    }

    private Notification notification(String message) {
        Intent open = new Intent(this, MainActivity.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent p = PendingIntent.getActivity(this, NOTIFICATION_ID, open, flags);
        return new Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("NPay 백그라운드 1페이지 테스트")
            .setContentText(message).setContentIntent(p).setOngoing(true).build();
    }

    private void status(String message) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(STATUS, message).apply();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void begin() {
        if (finished) return;
        try {
            webView = new WebView(this);
            WebSettings st = webView.getSettings();
            st.setJavaScriptEnabled(true);
            st.setDomStorageEnabled(true);
            st.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            st.setAllowFileAccess(false);
            st.setAllowContentAccess(false);
            st.setAllowFileAccessFromFileURLs(false);
            st.setAllowUniversalAccessFromFileURLs(false);
            st.setJavaScriptCanOpenWindowsAutomatically(false);
            st.setLoadsImagesAutomatically(false);
            String agent = st.getUserAgentString();
            st.setUserAgentString(agent.replace("; wv)", ")").replace("Version/4.0 ", ""));
            CookieManager.getInstance().setAcceptCookie(true);
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
            webView.setWebViewClient(new WebViewClient() {
                @Override public void onPageFinished(WebView view, String address) {
                    if (finished) return;
                    if (!history(address)) {
                        finish("로그인 필요 또는 결제내역 화면 접근 실패");
                        return;
                    }
                    handler.postDelayed(BackgroundProbeService.this::read, 1100L);
                }
                @Override public void onReceivedError(WebView v, WebResourceRequest req,
                                                     android.webkit.WebResourceError err) {
                    if (!finished && req.isForMainFrame()) {
                        finish("페이지 로딩 오류 · 네트워크 또는 세션 확인 필요");
                    }
                }
                @Override public boolean onRenderProcessGone(
                        WebView view, android.webkit.RenderProcessGoneDetail detail) {
                    webView = null;
                    view.destroy();
                    finish("WebView 렌더러 종료");
                    return true;
                }
            });
            status("백그라운드 WebView 페이지 요청 중");
            webView.loadUrl(URL);
        } catch (RuntimeException ex) {
            finish("WebView 초기화 실패");
        }
    }

    private boolean history(String address) {
        try {
            android.net.Uri u = android.net.Uri.parse(address);
            String p = u.getPath();
            return "https".equals(u.getScheme()) && "pay.naver.com".equals(u.getHost()) &&
                ("/history".equals(p) || "/history/".equals(p) ||
                 "/pc/history".equals(p) || "/pc/history/".equals(p));
        } catch (Exception ignored) { return false; }
    }

    private void read() {
        if (finished || webView == null) return;
        if (!history(webView.getUrl())) {
            finish("페이지 이동 또는 재로그인 필요");
            return;
        }
        try {
            webView.evaluateJavascript(PAGE_JS, ret -> {
                if (finished) return;
                try {
                    Object value = new JSONArray("[" + ret + "]").get(0);
                    if (!(value instanceof String)) throw new IllegalArgumentException();
                    JSONObject d = new JSONObject((String) value);
                    if (d.optBoolean("ok")) {
                        int count = d.getInt("count"), pages = d.getInt("pages");
                        if (count < 0 || count > 1000 || pages < 0 || pages > 500)
                            throw new IllegalArgumentException();
                        finish("백그라운드 조회 성공 · 1페이지 " + count +
                            "건 · 전체 " + pages + "페이지 · 상세정보 미수집");
                        return;
                    }
                    String code = d.optString("code", "UNKNOWN");
                    if ("WAIT".equals(code) && ++attempt < 12) {
                        handler.postDelayed(this::read, 1300L);
                        return;
                    }
                    if (!code.matches("WAIT|NOT_HISTORY|LIMIT|BAD_DATA|PARSE"))
                        code = "UNKNOWN";
                    finish("백그라운드 페이지 데이터 미확인 · 코드 " + code);
                } catch (Exception ex) {
                    finish("백그라운드 응답 처리 실패");
                }
            });
        } catch (RuntimeException ex) {
            finish("백그라운드 검사 실행 실패");
        }
    }

    private void finish(String message) {
        if (finished) return;
        finished = true;
        status(message);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override public void onDestroy() {
        finished = true;
        handler.removeCallbacksAndMessages(null);
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
