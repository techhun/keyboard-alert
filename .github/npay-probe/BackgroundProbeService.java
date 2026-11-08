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
import android.os.Message;
import android.os.PowerManager;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
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
    static final String ACTION_SCAN_ALL = "com.techhun.npayprobe.BG_SCAN_ALL";
    static final String ACTION_SHIP_SAMPLE = "com.techhun.npayprobe.BG_SHIP_SAMPLE";
    static final String ACTION_SHIP_MULTI = "com.techhun.npayprobe.BG_SHIP_MULTI";
    static final String ACTION_SHIP_PAGE = "com.techhun.npayprobe.BG_SHIP_PAGE";
    // Keep the previously tested small-sample bound. Allow more only in
    // the opt-in first-page scan, with the existing per-order / run timeouts.
    private static final int MAX_BUTTONS_PER_ITEM = 5;
    private static final int MAX_PAGE_BUTTONS_PER_ITEM = 10;
    private int buttonLimit(){return samplePage?MAX_PAGE_BUTTONS_PER_ITEM:MAX_BUTTONS_PER_ITEM;}
    static final String PREFS = "npay_bg_probe";
    static final String STATUS = "status";
    private static final int NOTIFICATION_ID = 62018;
    private static final int NOTIFICATION_DONE = 62019;
    private static final String CHANNEL = "npay_bg_probe";
    private static final String CHANNEL_DONE = "npay_bg_probe_result";
    private static final String URL = "https://pay.naver.com/pc/history?page=1&serviceChannel=SHOPPING";
    private static final String SHIPMENT_CONTEXT_JS = "(function(){try{var body=document.body,txt=body?body.innerText:'';var items=document.querySelectorAll('[role=dialog],dialog,[aria-modal=true]');var dialogs=0;for(var i=0;i<items.length&&i<60;i++)if(items[i].getClientRects().length)dialogs++;var controls=document.querySelectorAll('button,a,[role=button]');var clicks=0;for(var j=0;j<controls.length&&j<1200;j++){var z=controls[j];if(z.getClientRects().length&&['배송조회','배송 조회'].indexOf((z.innerText||'').trim())>=0)clicks++;}var frames=document.querySelectorAll('iframe'),readable=0,unreadable=0,payFrames=0,otherFrames=0,blankFrames=0,frameLabels=0,frameCarrier=0,frameBoth=0;var known=['CJ대한통운','한진택배','로젠택배','우체국택배','롯데택배','컬리넥스트마일','경동택배','대신택배'];for(var q=0;q<frames.length&&q<20;q++){var f=frames[q],raw=f.getAttribute('src')||'';if(!raw||raw==='about:blank')blankFrames++;else{try{var u=new URL(raw,location.href);if(u.origin===location.origin)payFrames++;else otherFrames++;}catch(_){otherFrames++;}}try{var d=f.contentDocument;if(!d||!d.body){unreadable++;continue;}readable++;var t=(d.body.innerText||'').slice(0,25000),label=t.indexOf('운송장')>=0||t.indexOf('송장번호')>=0,car=known.some(function(x){return t.indexOf(x)>=0;});if(label)frameLabels++;if(car)frameCarrier++;if(label&&car)frameBoth++;}catch(_){unreadable++;}}var path=location.pathname||'';var routeKind=/tracking|delivery|shipping|parcel/i.test(path)?'배송경로':/order|detail/i.test(path)?'주문상세':/history/i.test(path)?'결제목록':/payment|pay/i.test(path)?'결제화면':'기타Pay';var hasProductLabel=txt.indexOf('상품주문번호')>=0,hasLogin=txt.indexOf('로그인')>=0||txt.indexOf('본인인증')>=0,hasError=txt.indexOf('페이지를 찾을 수 없')>=0||txt.indexOf('오류가 발생')>=0||txt.indexOf('접근할 수 없')>=0;return JSON.stringify({ok:true,routeKind:routeKind,hasProductLabel:hasProductLabel,hasLogin:hasLogin,hasError:hasError,ready:document.readyState,bodyLength:Math.min(99999,txt.length),dialogs:Math.min(60,dialogs),frames:Math.min(99,frames.length),controls:Math.min(999,clicks),hasShipping:txt.indexOf('배송조회')>=0||txt.indexOf('배송 조회')>=0,hasParcel:txt.indexOf('운송장')>=0||txt.indexOf('송장번호')>=0,frameReadable:readable,frameUnreadable:unreadable,framePay:payFrames,frameOther:otherFrames,frameBlank:blankFrames,frameLabel:frameLabels,frameCarrier:frameCarrier,frameBoth:frameBoth});}catch(_){return JSON.stringify({ok:false});}})()";
    private static final String PAGE_JS = "(function(){try{var path=location.pathname;if(location.protocol!=='https:'||location.hostname!=='pay.naver.com'||['/history','/history/','/pc/history','/pc/history/'].indexOf(path)<0)return JSON.stringify({ok:false,code:'NOT_HISTORY'});var el=document.getElementById('__NEXT_DATA__');if(!el)return JSON.stringify({ok:false,code:'WAIT'});if(el.textContent.length>5000000)return JSON.stringify({ok:false,code:'LIMIT'});var d=JSON.parse(el.textContent),q=d&&d.props&&d.props.pageProps&&d.props.pageProps.dehydratedState&&d.props.pageProps.dehydratedState.queries;if(!Array.isArray(q))return JSON.stringify({ok:false,code:'WAIT'});var p=null;for(var i=0;i<q.length;i++){if(Array.isArray(q[i].queryKey)&&q[i].queryKey[0]==='PAYMENT_LIST'){var pages=q[i].state&&q[i].state.data&&q[i].state.data.pages;if(Array.isArray(pages))for(var j=0;j<pages.length;j++)if(Number(pages[j].curPage)===__PAGE__){p=pages[j];break;}if(p)break;}}if(!p)return JSON.stringify({ok:false,code:'WAIT'});var count=Array.isArray(p.items)?p.items.length:-1,total=Number(p.totalPage);if(count<0||count>1000||!Number.isInteger(total)||total<0||total>500)return JSON.stringify({ok:false,code:'BAD_DATA'});var ids=[];if(__IDS__){for(var k=0;k<count;k++){var item=p.items[k],id=item&&item.additionalData&&item.additionalData.productOrderNo;if(typeof id!=='string'||!(/^[A-Za-z0-9_-]{1,80}$/).test(id))return JSON.stringify({ok:false,code:'BAD_ID'});ids.push(id);}}return JSON.stringify({ok:true,count:count,pages:total,page:__PAGE__,ids:ids});}catch(_){return JSON.stringify({ok:false,code:'PARSE'});}})()";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView webView;
    private PowerManager.WakeLock wakeLock;
    private boolean started = false, finished = false, scanAll = false, readQueued = false,
        sampleShipping = false, sampleMulti = false, samplePage = false;
    private int sampleLimit=6, sampleStage=0, sampleStep=0, sampleIndex=0, sampleDone=0,
        sampleMatched=0, sampleNoButton=0, sampleUnknown=0, sampleCancelled=0,
        sampleClicks=0, samplePoll=0, sampleButtonIndex=0, sampleButtonCount=0,
        sampleEmptyReads=0, sampleEmptyRetries=0, sampleLateControls=0,
        sampleAmbiguousReads=0, sampleAmbiguousRetries=0,
        sampleControlsObserved=0, sampleButtonsFound=0, sampleControlsSkipped=0,
        sampleMultiOrders=0, sampleCachedEntries=0, sampleCachedButtons=0,
        sampleCacheChanged=0;
    private String sampleButtonSignature="",sampleIssue="",sampleDetailObservation="";
    private int sampleShippingNavigations=0, samplePopupRequests=0, samplePopupUserGestureRequests=0;
    private long sampleStartedAt=0L;
    private int sampleSharedDetail=0;
    private final java.util.HashSet<String> sampleDetailUrls=new java.util.HashSet<>();
    // Session-only order-detail cache. Never save order URLs or keys to disk.
    private static final class VerifiedDetail {
        final String signature;
        final int count, sourceItem;
        VerifiedDetail(String signature,int count,int sourceItem){
            this.signature=signature;this.count=count;this.sourceItem=sourceItem;
        }
    }
    private final java.util.HashMap<String,VerifiedDetail> verifiedDetails=new java.util.HashMap<>();
    private final java.util.ArrayList<String> reusedDetailNotes=new java.util.ArrayList<>();
    private final java.util.ArrayList<String> sampleIssueNotes=new java.util.ArrayList<>();
    private final java.util.ArrayList<String> sampleNoButtonNotes=new java.util.ArrayList<>();
    private void markSampleIssue(String safeCode){
        sampleIssue=safeCode;
    }
    /** Report schema presence only; never copy an invoice, parcel ID, or DOM text. */
    private String detailObservation(JSONObject d){
        int pairs=Math.max(0,Math.min(999,d.optInt("structuredPairs",0)));
        int invoices=Math.max(0,Math.min(999,d.optInt("structuredInvoices",0)));
        int carriers=Math.max(0,Math.min(999,d.optInt("structuredCarriers",0)));
        int domInvoices=Math.max(0,Math.min(999,d.optInt("domInvoices",0)));
        return "구조화쌍 "+pairs+" · 번호후보 "+invoices+
            " · 택배사후보 "+carriers+" · 화면번호 "+domInvoices+
            " · 라벨 "+(d.optBoolean("hasLabel")?"있음":"없음")+
            " · 탐색제한 "+(d.optBoolean("limited")?"있음":"없음");
    }
    /** Diagnostic categories only: never include page contents, order IDs or URLs. */
    private String ambiguityReason(JSONObject d){
        if(!d.optBoolean("targetPresent"))return "대상 상품 영역 미확인";
        if(d.optBoolean("cancelAmbiguous"))return "취소 상태 중복 판정";
        if(d.optBoolean("cancelLimited"))return "취소 상태 탐색 한도";
        if(d.optBoolean("controlLimited"))return "배송조회 버튼 탐색 한도";
        int blocked=Math.max(0,Math.min(1000,d.optInt("blockedControls",0)));
        if(blocked>0)return "배송조회 버튼 식별 제외 "+blocked+"개";
        return "배송조회 상태 미확인";
    }
    private final java.util.ArrayList<String[]> sampleTargets=new java.util.ArrayList<>();
    private int attempt = 0, visibleChecks = 0, page = 1, totalPages = -1, scanned = 0, duplicates = 0;
    private final java.util.HashSet<String> seenHashes = new java.util.HashSet<>();

    @Override public void onCreate() {
        super.onCreate();
        NotificationChannel channel = new NotificationChannel(
            CHANNEL, "NPay 일회성 조회 검증", NotificationManager.IMPORTANCE_LOW);
        NotificationManager nm=getSystemService(NotificationManager.class);
        nm.createNotificationChannel(channel);
        nm.createNotificationChannel(new NotificationChannel(
            CHANNEL_DONE,"NPay 조회 검사 완료",NotificationManager.IMPORTANCE_DEFAULT));
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            finish("사용자 중지 · 백그라운드 조회 종료");
            return START_NOT_STICKY;
        }
        if (started) return START_NOT_STICKY;
        started = true;
        scanAll = intent != null && ACTION_SCAN_ALL.equals(intent.getAction());
        sampleShipping = intent != null &&
            (ACTION_SHIP_SAMPLE.equals(intent.getAction())||
             ACTION_SHIP_MULTI.equals(intent.getAction())||
             ACTION_SHIP_PAGE.equals(intent.getAction()));
        samplePage = intent != null && ACTION_SHIP_PAGE.equals(intent.getAction());
        sampleMulti = samplePage || (intent != null && ACTION_SHIP_MULTI.equals(intent.getAction()));
        sampleLimit=samplePage?15:6;
        sampleStartedAt=System.currentTimeMillis();
        try {
            Notification notification = notification(sampleShipping?
                (samplePage?"백그라운드 첫 페이지 최대 15건 배송조회":
                    sampleMulti?"백그라운드 복수 배송조회 최대 6건":"백그라운드 배송조회 최대 6건")+" 검사 준비": scanAll?
                "백그라운드 전체 목록 검사 준비" : "화면 전환 후 구매목록 1페이지 검사");
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "npay:onepage-probe");
            wakeLock.acquire(samplePage? 760000L : sampleShipping? 240000L: scanAll ? 300000L : 55000L); // bounded, user initiated
            status("조회 대기 중 · 화면을 꺼도 테스트 진행");
            handler.postDelayed(this::begin, 8000L);
            handler.postDelayed(() -> finish(
                sampleShipping? "배송조회 시범 시간 초과 · "+sampleDone+"/"+sampleTargets.size()+
                    "건 완료 · 자동 중단 · 상세 미수집" :
                scanAll ? "시간 초과 · "+Math.max(0,page-1)+"페이지 완료 · 자동 중단" :
                "시간 초과 · 백그라운드 화면 응답 없음"),
                samplePage? 720000L : sampleShipping? 215000L : scanAll ? 280000L : 45000L);
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
            .setContentTitle(samplePage? "NPay 첫 페이지 배송조회 검사" :
                sampleShipping? "NPay 백그라운드 배송조회 시범" :
                scanAll ? "NPay 백그라운드 목록 검사" : "NPay 백그라운드 1페이지 테스트")
            .setContentText(message).setContentIntent(p).setOngoing(true).build();
    }

    private void status(String message) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putString(STATUS, message).putBoolean("running", !finished)
            .putLong("updated_at",System.currentTimeMillis()).apply();
    }
    private String modeName(){
        if(samplePage)return "백그라운드 첫 페이지 배송검사";
        if(sampleShipping)return sampleMulti?
            "백그라운드 묶음배송 시범":"백그라운드 배송정보 시범";
        if(scanAll)return "백그라운드 전체 구매목록";
        return "백그라운드 구매목록 1페이지";
    }
    private void progress(String message) {
        status(message);
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(message));
    }
    private void openPage(int target) {
        if (finished || webView == null) return;
        page = target;
        attempt = 0;
        readQueued = false;
        String pageUrl = "https://pay.naver.com/pc/history?page="+page+"&serviceChannel=SHOPPING";
        webView.loadUrl(pageUrl);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void begin() {
        if (finished) return;
        if (getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("ui_visible", true)) {
            if (++visibleChecks <= 12) {
                handler.postDelayed(this::begin, 1000L);
                return;
            }
            finish("백그라운드 전환 미확인 · 앱 홈/잠금 화면으로 이동 후 재검사");
            return;
        }
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
            // Only instrument user-initiated shipping probes. New windows remain
            // blocked until their destination can be verified; no popup is followed.
            st.setJavaScriptCanOpenWindowsAutomatically(sampleShipping);
            st.setSupportMultipleWindows(sampleShipping);
            st.setLoadsImagesAutomatically(false);
            st.setCacheMode(WebSettings.LOAD_NO_CACHE);
            String agent = st.getUserAgentString();
            st.setUserAgentString(agent.replace("; wv)", ")").replace("Version/4.0 ", ""));
            CookieManager.getInstance().setAcceptCookie(true);
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
            if(sampleShipping){
                webView.setWebChromeClient(new WebChromeClient(){
                    @Override public boolean onCreateWindow(WebView view,boolean dialog,
                            boolean userGesture,Message message){
                        if(!finished&&sampleStage==2){
                            samplePopupRequests++;
                            if(userGesture)samplePopupUserGestureRequests++;
                        }
                        // Never open an unverified popup or external courier service.
                        return false;
                    }
                });
            }
            webView.setWebViewClient(new WebViewClient() {
                @Override public void onPageFinished(WebView view, String address) {
                    if (finished) return;
                    if (sampleShipping){
                        if(sampleStage==0){
                            if(!history(address)){finish("배송조회 시범 · 로그인/목록 접근 실패");return;}
                            if(!readQueued){
                                readQueued=true;
                                handler.postDelayed(BackgroundProbeService.this::sampleListRead,1100L);
                            }
                        }else if(sampleStage==1){
                            if(!safeDetailUrl(address)){
                                markSampleIssue("주문상세 외부 주소 이동");
                                advanceSample(2);return;
                            }
                            if(!readQueued){
                                readQueued=true;
                                handler.postDelayed(BackgroundProbeService.this::readSampleDetail,1200L);
                            }
                        }else if(sampleStage==2) {
                            // No URLs are stored; record only navigation count after click.
                            sampleShippingNavigations++;
                        }
                        return;
                    }
                    if (!history(address)) {
                        finish("로그인 필요 또는 결제내역 화면 접근 실패");
                        return;
                    }
                    if (!readQueued) {
                        readQueued = true;
                        handler.postDelayed(BackgroundProbeService.this::read, 1100L);
                    }
                }
                @Override public void onReceivedError(WebView v, WebResourceRequest req,
                                                     android.webkit.WebResourceError err) {
                    if (!finished && req.isForMainFrame()) {
                        if(sampleShipping&&(sampleStage==1||sampleStage==2)){
                            markSampleIssue("배송조회 페이지 네트워크 오류");
                            advanceSample(2);
                        }
                        else finish("페이지 로딩 오류 · 네트워크 또는 세션 확인 필요");
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
            progress("백그라운드 WebView "+(sampleShipping?"배송조회 시범":scanAll?"목록 검사":"1페이지")+" 요청 중");
            openPage(1);
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
            final int readingPage = page;
            String script = PAGE_JS.replace("__PAGE__", String.valueOf(readingPage))
                .replace("__IDS__", scanAll ? "true" : "false");
            webView.evaluateJavascript(script, ret -> {
                if (finished || readingPage != page) return;
                try {
                    Object value = new JSONArray("[" + ret + "]").get(0);
                    if (!(value instanceof String)) throw new IllegalArgumentException();
                    JSONObject d = new JSONObject((String) value);
                    if (d.optBoolean("ok")) {
                        int count = d.getInt("count"), pages = d.getInt("pages");
                        if (count < 0 || count > 1000 || pages < 0 || pages > 500 || d.getInt("page") != page)
                            throw new IllegalArgumentException();
                        if (scanAll) {
                            completePage(d, count, pages);
                            return;
                        }
                        if (getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("ui_visible", true)) {
                            finish("1페이지 응답은 확인했지만 완료 시 앱이 전면에 있어 백그라운드 검증 미확정");
                            return;
                        }
                        finish("백그라운드 조회 성공 · 1페이지 " + count +
                            "건 · 전체 " + pages + "페이지 · 상세정보 미수집");
                        return;
                    }
                    String code = d.optString("code", "UNKNOWN");
                    if ("WAIT".equals(code) && ++attempt < 12) {
                        handler.postDelayed(this::read, 1300L);
                        return;
                    }
                    if (!code.matches("WAIT|NOT_HISTORY|LIMIT|BAD_DATA|BAD_ID|PARSE"))
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

    private void completePage(JSONObject d, int count, int pages) throws Exception {
        if (totalPages == -1) {
            if (pages < 1 || pages > 100) { finish("전체 페이지 수 범위 초과 · 자동 중지"); return; }
            totalPages = pages;
        } else if (pages != totalPages) {
            finish("검사 도중 전체 페이지 수 변경 · "+Math.max(0,page-1)+"페이지 완료 · 중지");
            return;
        }
        JSONArray ids = d.getJSONArray("ids");
        if (ids.length() != count) throw new IllegalArgumentException();
        java.util.ArrayList<String> hashes = new java.util.ArrayList<>();
        java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
        for (int i=0;i<ids.length();i++) {
            String id = ids.getString(i);
            if (!id.matches("[A-Za-z0-9_-]{1,80}")) throw new IllegalArgumentException();
            String hash = android.util.Base64.encodeToString(
                digest.digest(id.getBytes(java.nio.charset.StandardCharsets.UTF_8)),
                android.util.Base64.NO_WRAP);
            hashes.add(hash);
        }
        int newItems = 0;
        for (String hash : hashes) {
            if (seenHashes.add(hash)) newItems++;
            else duplicates++;
        }
        if (newItems == 0 && count > 0) {
            finish("동일한 목록 반복 · "+page+"페이지에서 중단"); return;
        }
        scanned++;
        if (page >= totalPages) {
            if (getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("ui_visible", true)) {
                finish("전체 목록 조회 "+scanned+"/"+totalPages+"페이지 · "+seenHashes.size()+
                    "건 (완료 시 앱 화면 전면 · 백그라운드 지속 검증 미확정)");
            } else {
                finish("백그라운드 전체 목록 조회 성공 · "+scanned+"/"+totalPages+"페이지 · "+
                    seenHashes.size()+"건 · 중복 "+duplicates+"건 · 상세정보 미수집");
            }
            return;
        }
        progress("백그라운드 목록 "+scanned+"/"+totalPages+"페이지 · "+
            seenHashes.size()+"건 · 중복 "+duplicates+"건");
        final int next = page+1;
        handler.postDelayed(() -> openPage(next), 1500L);
    }

    // Bounded pilot: the first six shopping-list entries with a safe detail URL.
    // We inspect at most one delivery control per entry. This does not establish
    // item-level invoice linkage and does not persist full identifiers.
    private JSONObject decode(String ret) throws Exception {
        if (ret == null || ret.length()>150000) throw new IllegalArgumentException();
        Object value = new JSONArray("["+ret+"]").get(0);
        if (!(value instanceof String)) throw new IllegalArgumentException();
        return new JSONObject((String)value);
    }
    private boolean safeDetailUrl(String url) {
        try {
            if (url==null || url.length()>4096) return false;
            android.net.Uri u=android.net.Uri.parse(url);
            String h=u.getHost();
            return "https".equals(u.getScheme()) && u.getUserInfo()==null &&
                h!=null && ("pay.naver.com".equals(h)||h.endsWith(".pay.naver.com"));
        } catch(Exception ignored) {return false;}
    }
    private void sampleListRead() {
        if(finished||!sampleShipping||sampleStage!=0||webView==null)return;
        try {
            String script=BackgroundDeliveryScripts.SAMPLE_LIST_JS.replace(
                "__SAMPLE_LIMIT__",String.valueOf(sampleLimit));
            webView.evaluateJavascript(script, ret -> {
                if(finished||sampleStage!=0)return;
                try{
                    JSONObject d=decode(ret);
                    if(!d.optBoolean("ok")) {
                        if("WAIT".equals(d.optString("code")) && ++attempt<12) {
                            handler.postDelayed(this::sampleListRead,1200L);return;
                        }
                        finish("배송조회 시범 · 목록 준비 실패 · 상세검사 0건");return;
                    }
                    JSONArray a=d.getJSONArray("candidates");
                    if(a.length()>sampleLimit||a.length()==0){finish("배송조회 시범 · 유효한 상세 링크 없음");return;}
                    for(int i=0;i<a.length();i++){
                        JSONObject row=a.getJSONObject(i);
                        String id=row.getString("id"),url=row.getString("url");
                        if(!id.matches("[A-Za-z0-9_-]{1,80}")||!safeDetailUrl(url))throw new IllegalArgumentException();
                        sampleTargets.add(new String[]{id,url});
                        if(!sampleDetailUrls.add(url))sampleSharedDetail++;
                    }
                    sampleIndex=0;
                    nextSample();
                }catch(Exception ex){finish("배송조회 시범 · 목록 응답 검증 실패");}
            });
        }catch(RuntimeException ex){finish("배송조회 시범 · 목록 실행 실패");}
    }
    private void nextSample(){
        if(finished||!sampleShipping)return;
        if(sampleIndex>=sampleTargets.size()){
            String marker=getSharedPreferences(PREFS,MODE_PRIVATE).getBoolean("ui_visible",true)?
                " · 종료 시 화면 전면(백그라운드 지속 검증 미확정)":" · 백그라운드 실행 확인";
            finish("배송조회 시범 종료 · "+sampleDone+"/"+sampleTargets.size()+
                "건 · 배송정보 표시 "+sampleMatched+"건 · 버튼 없음 "+sampleNoButton+
                "건 · 취소 "+sampleCancelled+"건 · 추가확인 "+sampleUnknown+
                "건 · 직접 버튼검사 "+sampleClicks+"개"+
                (sampleMulti?" · 복수버튼 주문 "+sampleMultiOrders+
                    "건 · 발견 "+sampleControlsObserved+"개 · 표시 "+sampleButtonsFound+
                    "개 · 미확인 "+sampleControlsSkipped+"개":"")+
                (sampleIssueNotes.isEmpty()?"":" · 추가확인 위치 "+
                    android.text.TextUtils.join(" / ",sampleIssueNotes))+
                (sampleNoButtonNotes.isEmpty()?"":" · 버튼없음 위치 "+
                    android.text.TextUtils.join(" / ",sampleNoButtonNotes))+
                (sampleMulti?" · 버튼 재확인 "+sampleEmptyRetries+"회"+
                    " · 지연 발견 "+sampleLateControls+"건"+
                    " · 식별 재확인 "+sampleAmbiguousRetries+"회":"")+
                (samplePage?" · 같은 상세 URL "+sampleSharedDetail+"건"+
                    " · 검증 결과 재사용 "+sampleCachedEntries+"건/"+sampleCachedButtons+"개"+
                    " · 상세 구성 변경 "+sampleCacheChanged+"건"+
                    " · 검사 한도 "+buttonLimit()+"개/항목"+
                    " · 소요 "+((System.currentTimeMillis()-sampleStartedAt)/1000L)+"초":"")+
                (reusedDetailNotes.isEmpty()?"":" · 재사용 위치 "+
                    android.text.TextUtils.join(" / ",reusedDetailNotes)+
                    " (동일 주문상세만 확인 · 상품별 송장 연결 미확정)")+marker);
            return;
        }
        String url=sampleTargets.get(sampleIndex)[1];
        sampleStage=1;attempt=0;readQueued=false;
        sampleButtonIndex=0;sampleButtonCount=0;sampleButtonSignature="";sampleIssue="";
        sampleDetailObservation="";
        sampleEmptyReads=0;sampleAmbiguousReads=0;
        sampleShippingNavigations=0;samplePopupRequests=0;samplePopupUserGestureRequests=0;
        final int step=++sampleStep;
        progress("배송조회 시범 "+sampleDone+"/"+sampleTargets.size()+"건 완료 · 상세화면 읽는 중");
        final int watchedIndex=sampleIndex;
        handler.postDelayed(()->{
            // Monotonic item index is stable across every button in the same order.
            if(!finished&&sampleShipping&&sampleIndex==watchedIndex&&
                (sampleStage==1||sampleStage==2)){
                markSampleIssue("주문상세 시간 초과");
                advanceSample(2);
            }
        },55000L);
        try{webView.loadUrl(url);}catch(RuntimeException ex){advanceSample(2);}
    }
    private void readSampleDetail(){
        if(finished||!sampleShipping||sampleStage!=1||webView==null)return;
        final int step=sampleStep;
        String id=sampleTargets.get(sampleIndex)[0],link=sampleTargets.get(sampleIndex)[1];
        if(!safeDetailUrl(webView.getUrl())||!link.equals(webView.getUrl())){
            advanceSample(2);return;
        }
        try{
            webView.evaluateJavascript(
                BackgroundDeliveryScripts.AUTO_JS+"("+JSONObject.quote(id)+")",ret->{
                if(finished||step!=sampleStep||sampleStage!=1)return;
                try {
                    JSONObject d=decode(ret);
                    if(!d.optBoolean("ok")){
                        markSampleIssue("주문상세 구조 분석 실패");advanceSample(2);return;
                    }
                    if(!d.optBoolean("targetPresent")&&++attempt<5){
                        handler.postDelayed(this::readSampleDetail,1400L);return;
                    }
                    if(d.optBoolean("targetCancelled")){
                        // A cancellation after a prior button is an inconsistent detail page.
                        advanceSample(sampleButtonIndex==0?0:2);return;
                    }
                    JSONArray keys=d.getJSONArray("controlKeys");
                    if(d.optBoolean("controlLimited")||d.optBoolean("cancelLimited")||
                        d.optBoolean("cancelAmbiguous")||d.optInt("blockedControls")>0||
                        !d.optBoolean("targetPresent")){
                        // Recheck only before clicking the first control; never click
                        // an index on an ambiguous or changed detail-page structure.
                        if(sampleButtonIndex==0&&++sampleAmbiguousReads<3){
                            sampleAmbiguousRetries++;
                            handler.postDelayed(this::readSampleDetail,1400L);
                            return;
                        }
                        markSampleIssue(ambiguityReason(d));
                        advanceSample(2);return;
                    }
                    sampleAmbiguousReads=0;
                    if(keys.length()==0){
                        if(sampleButtonIndex>0){
                            markSampleIssue("다음 버튼 검사 시 구성 변경");
                            advanceSample(2);return;
                        }
                        // React can render shipping controls after the item label appears.
                        // A single empty DOM snapshot must not certify an absent button.
                        if(++sampleEmptyReads<4){
                            sampleEmptyRetries++;
                            handler.postDelayed(this::readSampleDetail,1300L);
                            return;
                        }
                        if(sampleNoButtonNotes.size()<sampleLimit)
                            sampleNoButtonNotes.add((sampleIndex+1)+"번(4회 재확인)");
                        advanceSample(1);return;
                    }
                    if(sampleEmptyReads>0)sampleLateControls++;
                    sampleEmptyReads=0;
                    if(keys.length()>20){
                        markSampleIssue("버튼 수 초과");
                        advanceSample(2);return;
                    }
                    String signature=keys.toString();
                    // Only reuse after all controls on this exact detail URL were
                    // independently clicked and showed a delivery candidate.
                    // The target product is validated separately above. Same
                    // detail is NOT evidence of per-product invoice association.
                    if(samplePage&&sampleButtonIndex==0){
                        VerifiedDetail prior=verifiedDetails.get(link);
                        if(prior!=null){
                            if(prior.count==keys.length()&&prior.signature.equals(signature)){
                                sampleCachedEntries++;
                                sampleCachedButtons+=keys.length();
                                sampleControlsObserved+=keys.length();
                                if(keys.length()>1)sampleMultiOrders++;
                                if(reusedDetailNotes.size()<sampleLimit)
                                    reusedDetailNotes.add((sampleIndex+1)+"번←"+prior.sourceItem+"번");
                                advanceSample(3);
                                return;
                            }
                            sampleCacheChanged++;
                        }
                    }
                    if(sampleButtonIndex==0){
                        sampleButtonCount=keys.length();
                        sampleButtonSignature=signature;
                        sampleControlsObserved+=keys.length();
                        if(keys.length()>1)sampleMultiOrders++;
                    }else if(sampleButtonCount!=keys.length()||
                            !sampleButtonSignature.equals(signature)||
                            sampleButtonIndex>=keys.length()){
                        // Do not click an index from a changed button configuration.
                        markSampleIssue("버튼 구성 변경");
                        advanceSample(2);return;
                    }
                    sampleStage=2;sampleStep++;samplePoll=0;
                    sampleShippingNavigations=0;samplePopupRequests=0;samplePopupUserGestureRequests=0;
                    sampleDetailObservation="배송정보 응답 없음";
                    final int clickStep=sampleStep;
                    String command=BackgroundDeliveryScripts.CLICK_JS+"("+
                        JSONObject.quote(link)+","+JSONObject.quote(signature)+","+
                        sampleButtonIndex+")";
                    webView.evaluateJavascript(command,clicked->{
                        if(finished||sampleStage!=2||sampleStep!=clickStep)return;
                        try {
                            if(!"CLICKED".equals(decode(clicked).optString("state"))){
                                markSampleIssue("버튼 클릭 미확인");
                                advanceSample(2);return;
                            }
                            sampleClicks++;
                            handler.postDelayed(()->pollSampleShipping(clickStep),1400L);
                        }catch(Exception ex){advanceSample(2);}
                    });
                }catch(Exception ex){advanceSample(2);}
            });
        }catch(RuntimeException ex){advanceSample(2);}
    }
    private void pollSampleShipping(int step){
        if(finished||sampleStep!=step||sampleStage!=2||webView==null)return;
        if(!safeDetailUrl(webView.getUrl())){
            markSampleIssue("배송조회 후 Pay 외부 주소 이동 · 데이터 미수집");
            advanceSample(2);return;
        }
        try{
            webView.evaluateJavascript(BackgroundDeliveryScripts.DETAIL_JS,ret->{
                if(finished||sampleStep!=step||sampleStage!=2)return;
                try{
                    JSONObject d=decode(ret);
                    if(!d.optBoolean("ok")){
                        markSampleIssue("배송화면 분석 실패");
                        advanceSample(2);return;
                    }
                    sampleDetailObservation=detailObservation(d);
                    if(d.getJSONArray("domPairs").length()>0){
                        sampleButtonsFound++;
                        sampleButtonIndex++;
                        if(sampleMulti && sampleButtonIndex<sampleButtonCount &&
                            sampleButtonIndex<buttonLimit()){
                            // Reopen original detail before testing the next distinct control.
                            sampleStage=1;sampleStep++;readQueued=false;attempt=0;
                            final int nextStep=sampleStep;
                            handler.postDelayed(()->{
                                if(!finished&&sampleStep==nextStep&&sampleStage==1)
                                    webView.loadUrl(sampleTargets.get(sampleIndex)[1]);
                            },700L);
                            return;
                        }
                        // If more controls remain, count this as unverified, not fully matched.
                        if(sampleMulti && sampleButtonIndex<sampleButtonCount){
                            markSampleIssue("건당 "+buttonLimit()+"개 검사 한도");
                            advanceSample(2);
                        }else {
                            if(samplePage&&sampleButtonCount>0&&
                                sampleButtonIndex==sampleButtonCount){
                                String detailUrl=sampleTargets.get(sampleIndex)[1];
                                verifiedDetails.put(detailUrl,new VerifiedDetail(
                                    sampleButtonSignature,sampleButtonCount,sampleIndex+1));
                            }
                            advanceSample(3);
                        }
                        return;
                    }
                    if(++samplePoll<9){
                        handler.postDelayed(()->pollSampleShipping(step),1300L);return;
                    }
                    collectMissingShipmentContext(step);
                }catch(Exception ex){
                    markSampleIssue("배송화면 응답 형식 오류");
                    advanceSample(2);
                }
            });
        }catch(RuntimeException ex){
            markSampleIssue("배송화면 검사 실행 실패");
            advanceSample(2);
        }
    }
    private void collectMissingShipmentContext(int step){
        if(finished||sampleStage!=2||sampleStep!=step||webView==null)return;
        final String current=webView.getUrl();
        final String original=sampleTargets.get(sampleIndex)[1];
        // URL equality only. Never include any URL, product or tracking identifier in reports.
        final String navigation=original.equals(current)?"주문상세 유지":"다른 Pay 화면";
        final int navigations=Math.min(99,sampleShippingNavigations);
        try{
            webView.evaluateJavascript(SHIPMENT_CONTEXT_JS,ret->{
                if(finished||sampleStage!=2||sampleStep!=step)return;
                String context="화면 구조 확인 실패";
                try{
                    JSONObject d=decode(ret);
                    if(d.optBoolean("ok")){
                        String ready=d.optString("ready","unknown");
                        if(!"complete".equals(ready)&&!"interactive".equals(ready)&&
                            !"loading".equals(ready))ready="unknown";
                        context="화면 "+ready+" · 본문길이 "+
                            Math.max(0,Math.min(99999,d.optInt("bodyLength",0)))+
                            " · 대화상자 "+Math.max(0,Math.min(60,d.optInt("dialogs",0)))+
                            " · iframe "+Math.max(0,Math.min(99,d.optInt("frames",0)))+
                            " · 배송버튼 "+Math.max(0,Math.min(999,d.optInt("controls",0)))+
                            " · 배송문구 "+(d.optBoolean("hasShipping")?"있음":"없음")+
                            " · 운송장문구 "+(d.optBoolean("hasParcel")?"있음":"없음")+
                            " · 프레임접근 "+Math.max(0,Math.min(20,d.optInt("frameReadable",0)))+
                            " · 프레임접근불가 "+Math.max(0,Math.min(20,d.optInt("frameUnreadable",0)))+
                            " · Pay프레임 "+Math.max(0,Math.min(20,d.optInt("framePay",0)))+
                            " · 타출처프레임 "+Math.max(0,Math.min(20,d.optInt("frameOther",0)))+
                            " · 빈프레임 "+Math.max(0,Math.min(20,d.optInt("frameBlank",0)))+
                            " · 프레임운송장표시 "+Math.max(0,Math.min(20,d.optInt("frameLabel",0)))+
                            " · 프레임택배사표시 "+Math.max(0,Math.min(20,d.optInt("frameCarrier",0)))+
                            " · 프레임동시표시 "+Math.max(0,Math.min(20,d.optInt("frameBoth",0)))+
                            " · 화면종류 "+d.optString("routeKind","기타Pay")+
                            " · 상품주문표시 "+(d.optBoolean("hasProductLabel")?"있음":"없음")+
                            " · 로그인문구 "+(d.optBoolean("hasLogin")?"있음":"없음")+
                            " · 오류문구 "+(d.optBoolean("hasError")?"있음":"없음");
                    }
                }catch(Exception ignored){ /* Record only sanitized fallback. */ }
                markSampleIssue("배송정보 미검출 ("+sampleDetailObservation+
                    " · "+navigation+" · 로드완료 "+navigations+"회"+
                    " · 새창요청 "+Math.min(99,samplePopupRequests)+"회"+
                    " · 사용자제스처 새창 "+Math.min(99,samplePopupUserGestureRequests)+"회 · "+context+")");
                advanceSample(2);
            });
        }catch(RuntimeException ex){
            markSampleIssue("배송정보 미검출 ("+sampleDetailObservation+
                " · "+navigation+" · 화면 진단 실행 실패)");
            advanceSample(2);
        }
    }
    private void advanceSample(int outcome){
        if(finished||!sampleShipping||sampleIndex>=sampleTargets.size())return;
        // outcome: 0 explicit cancelled, 1 no button, 2 unknown, 3 display hit.
        if(outcome==1)sampleNoButton++;
        else if(outcome==2){
            sampleUnknown++;
            if(sampleMulti && sampleButtonCount>sampleButtonIndex)
                sampleControlsSkipped+=sampleButtonCount-sampleButtonIndex;
            if(sampleIssueNotes.size()<sampleLimit)
                sampleIssueNotes.add((sampleIndex+1)+"번:"+
                    (sampleIssue.isEmpty()?"상세 확인 실패":sampleIssue));
        }
        else if(outcome==3)sampleMatched++;
        if(outcome==0)sampleCancelled++;
        sampleDone++;sampleIndex++;sampleStep++;sampleStage=3;readQueued=false;
        progress("배송조회 시범 "+sampleDone+"/"+sampleTargets.size()+
            "건 · 표시정보 "+sampleMatched+" · 추가확인 "+sampleUnknown);
        handler.postDelayed(this::nextSample,1400L);
    }
    private void finish(String message) {
        if (finished) return;
        finished = true;
        status(message);
        // Persist only sanitized aggregate/position diagnostics for copying.
        getSharedPreferences(PREFS,MODE_PRIVATE).edit()
            .putString("last_result",message)
            .putString("last_mode",modeName())
            .putLong("last_finished_at",System.currentTimeMillis()).apply();
        stopForeground(STOP_FOREGROUND_REMOVE);
        try {
            PendingIntent p=PendingIntent.getActivity(this,NOTIFICATION_DONE,
                new Intent(this,MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification note=new Notification.Builder(this,CHANNEL_DONE)
                .setSmallIcon(android.R.drawable.stat_notify_more)
                .setContentTitle("NPay 검사 종료 · 앱에서 결과 확인")
                .setContentText(message).setContentIntent(p).setAutoCancel(true).build();
            getSystemService(NotificationManager.class).notify(NOTIFICATION_DONE,note);
        } catch(RuntimeException ignored) {
            // The sanitized result is still available in the app if notifications are blocked.
        }
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
        sampleTargets.clear();sampleDetailUrls.clear();verifiedDetails.clear();
        reusedDetailNotes.clear();seenHashes.clear();
        sampleIssueNotes.clear();sampleNoButtonNotes.clear();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
