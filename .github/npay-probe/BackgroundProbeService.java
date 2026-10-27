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
    static final String ACTION_SCAN_ALL = "com.techhun.npayprobe.BG_SCAN_ALL";
    static final String ACTION_SHIP_SAMPLE = "com.techhun.npayprobe.BG_SHIP_SAMPLE";
    static final String PREFS = "npay_bg_probe";
    static final String STATUS = "status";
    private static final int NOTIFICATION_ID = 62018;
    private static final String CHANNEL = "npay_bg_probe";
    private static final String URL = "https://pay.naver.com/pc/history?page=1&serviceChannel=SHOPPING";
    private static final String PAGE_JS = "(function(){try{var path=location.pathname;if(location.protocol!=='https:'||location.hostname!=='pay.naver.com'||['/history','/history/','/pc/history','/pc/history/'].indexOf(path)<0)return JSON.stringify({ok:false,code:'NOT_HISTORY'});var el=document.getElementById('__NEXT_DATA__');if(!el)return JSON.stringify({ok:false,code:'WAIT'});if(el.textContent.length>5000000)return JSON.stringify({ok:false,code:'LIMIT'});var d=JSON.parse(el.textContent),q=d&&d.props&&d.props.pageProps&&d.props.pageProps.dehydratedState&&d.props.pageProps.dehydratedState.queries;if(!Array.isArray(q))return JSON.stringify({ok:false,code:'WAIT'});var p=null;for(var i=0;i<q.length;i++){if(Array.isArray(q[i].queryKey)&&q[i].queryKey[0]==='PAYMENT_LIST'){var pages=q[i].state&&q[i].state.data&&q[i].state.data.pages;if(Array.isArray(pages))for(var j=0;j<pages.length;j++)if(Number(pages[j].curPage)===__PAGE__){p=pages[j];break;}if(p)break;}}if(!p)return JSON.stringify({ok:false,code:'WAIT'});var count=Array.isArray(p.items)?p.items.length:-1,total=Number(p.totalPage);if(count<0||count>1000||!Number.isInteger(total)||total<0||total>500)return JSON.stringify({ok:false,code:'BAD_DATA'});var ids=[];if(__IDS__){for(var k=0;k<count;k++){var item=p.items[k],id=item&&item.additionalData&&item.additionalData.productOrderNo;if(typeof id!=='string'||!(/^[A-Za-z0-9_-]{1,80}$/).test(id))return JSON.stringify({ok:false,code:'BAD_ID'});ids.push(id);}}return JSON.stringify({ok:true,count:count,pages:total,page:__PAGE__,ids:ids});}catch(_){return JSON.stringify({ok:false,code:'PARSE'});}})()";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView webView;
    private PowerManager.WakeLock wakeLock;
    private boolean started = false, finished = false, scanAll = false, readQueued = false,
        sampleShipping = false;
    private int sampleStage=0, sampleStep=0, sampleIndex=0, sampleDone=0,
        sampleMatched=0, sampleNoButton=0, sampleUnknown=0, sampleClicks=0, samplePoll=0;
    private final java.util.ArrayList<String[]> sampleTargets=new java.util.ArrayList<>();
    private int attempt = 0, visibleChecks = 0, page = 1, totalPages = -1, scanned = 0, duplicates = 0;
    private final java.util.HashSet<String> seenHashes = new java.util.HashSet<>();

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
        scanAll = intent != null && ACTION_SCAN_ALL.equals(intent.getAction());
        sampleShipping = intent != null && ACTION_SHIP_SAMPLE.equals(intent.getAction());
        try {
            Notification notification = notification(sampleShipping?
                "백그라운드 배송조회 최대 6건 검사 준비": scanAll?
                "백그라운드 전체 목록 검사 준비" : "화면 전환 후 구매목록 1페이지 검사");
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "npay:onepage-probe");
            wakeLock.acquire(sampleShipping? 240000L: scanAll ? 300000L : 55000L); // bounded
            status("조회 대기 중 · 화면을 꺼도 테스트 진행");
            handler.postDelayed(this::begin, 8000L);
            handler.postDelayed(() -> finish(
                sampleShipping? "배송조회 시범 시간 초과 · "+sampleDone+"건 완료 · 중단" :
                scanAll ? "시간 초과 · "+Math.max(0,page-1)+"페이지 완료 · 자동 중단" :
                "시간 초과 · 백그라운드 화면 응답 없음"), sampleShipping? 215000L : scanAll ? 280000L : 45000L);
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
            .setContentTitle(sampleShipping? "NPay 백그라운드 배송조회 시범" :
                scanAll ? "NPay 백그라운드 목록 검사" : "NPay 백그라운드 1페이지 테스트")
            .setContentText(message).setContentIntent(p).setOngoing(true).build();
    }

    private void status(String message) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putString(STATUS, message).putBoolean("running", !finished).apply();
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
            st.setJavaScriptCanOpenWindowsAutomatically(false);
            st.setLoadsImagesAutomatically(false);
            st.setCacheMode(WebSettings.LOAD_NO_CACHE);
            String agent = st.getUserAgentString();
            st.setUserAgentString(agent.replace("; wv)", ")").replace("Version/4.0 ", ""));
            CookieManager.getInstance().setAcceptCookie(true);
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
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
                            if(!safeDetailUrl(address)){advanceSample(2);return;}
                            if(!readQueued){
                                readQueued=true;
                                handler.postDelayed(BackgroundProbeService.this::readSampleDetail,1200L);
                            }
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
                        if(sampleShipping&&sampleStage>0)advanceSample(2);
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
            webView.evaluateJavascript(BackgroundDeliveryScripts.SAMPLE_LIST_JS, ret -> {
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
                    if(a.length()>6||a.length()==0){finish("배송조회 시범 · 유효한 상세 링크 없음");return;}
                    for(int i=0;i<a.length();i++){
                        JSONObject row=a.getJSONObject(i);
                        String id=row.getString("id"),url=row.getString("url");
                        if(!id.matches("[A-Za-z0-9_-]{1,80}")||!safeDetailUrl(url))throw new IllegalArgumentException();
                        sampleTargets.add(new String[]{id,url});
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
                "건 · 추가확인 "+sampleUnknown+"건"+marker);
            return;
        }
        String url=sampleTargets.get(sampleIndex)[1];
        sampleStage=1;attempt=0;readQueued=false;
        final int step=++sampleStep;
        progress("배송조회 시범 "+sampleDone+"/"+sampleTargets.size()+"건 완료 · 상세화면 읽는 중");
        handler.postDelayed(()->{
            if(!finished&&sampleShipping&&step==sampleStep&&sampleStage!=0)
                advanceSample(2);
        },30000L);
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
                    if(!d.optBoolean("ok"))throw new IllegalArgumentException();
                    if(!d.optBoolean("targetPresent")&&++attempt<5){
                        handler.postDelayed(this::readSampleDetail,1400L);return;
                    }
                    if(d.optBoolean("targetCancelled")){
                        advanceSample(0);return;
                    }
                    JSONArray keys=d.getJSONArray("controlKeys");
                    if(d.optBoolean("controlLimited")||d.optInt("blockedControls")>0||
                        !d.optBoolean("targetPresent")){
                        advanceSample(2);return;
                    }
                    if(keys.length()==0){
                        advanceSample(1);return;
                    }
                    if(keys.length()>20){advanceSample(2);return;}
                    String signature=keys.toString();
                    sampleStage=2;sampleStep++;samplePoll=0;
                    final int clickStep=sampleStep;
                    String command=BackgroundDeliveryScripts.CLICK_JS+"("+
                        JSONObject.quote(link)+","+JSONObject.quote(signature)+",0)";
                    webView.evaluateJavascript(command,clicked->{
                        if(finished||sampleStage!=2||sampleStep!=clickStep)return;
                        try {
                            if(!"CLICKED".equals(decode(clicked).optString("state"))){
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
        if(!safeDetailUrl(webView.getUrl())){advanceSample(2);return;}
        try{
            webView.evaluateJavascript(BackgroundDeliveryScripts.DETAIL_JS,ret->{
                if(finished||sampleStep!=step||sampleStage!=2)return;
                try{
                    JSONObject d=decode(ret);
                    if(!d.optBoolean("ok"))throw new IllegalArgumentException();
                    if(d.getJSONArray("domPairs").length()>0){
                        advanceSample(3);return;
                    }
                    if(++samplePoll<9){
                        handler.postDelayed(()->pollSampleShipping(step),1300L);return;
                    }
                    advanceSample(2);
                }catch(Exception ex){advanceSample(2);}
            });
        }catch(RuntimeException ex){advanceSample(2);}
    }
    private void advanceSample(int outcome){
        if(finished||!sampleShipping||sampleIndex>=sampleTargets.size())return;
        // outcome: 0 explicit cancelled, 1 no button, 2 unknown, 3 display hit.
        if(outcome==1)sampleNoButton++;
        else if(outcome==2)sampleUnknown++;
        else if(outcome==3)sampleMatched++;
        sampleDone++;sampleIndex++;sampleStep++;sampleStage=0;readQueued=false;
        progress("배송조회 시범 "+sampleDone+"/"+sampleTargets.size()+
            "건 · 표시정보 "+sampleMatched+" · 추가확인 "+sampleUnknown);
        handler.postDelayed(this::nextSample,1400L);
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
        sampleTargets.clear();seenHashes.clear();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
