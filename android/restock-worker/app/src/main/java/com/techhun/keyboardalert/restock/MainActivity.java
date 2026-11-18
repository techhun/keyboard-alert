package com.techhun.keyboardalert.restock;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.net.Uri;
import android.text.Editable;
import android.text.InputType;
import android.text.Spannable;
import android.text.SpannableStringBuilder;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.text.style.ForegroundColorSpan;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public class MainActivity extends Activity {
    private static final int REQUEST_LOGIN = 9001;
    private static final String SMARTSTORE_HOME = "https://m.smartstore.naver.com/";
    private static final Object EMPTY_STATE_TAG = new Object();

    // 색은 res/values/colors.xml에만 두고 화면은 이 값들을 받아 쓴다.
    private int BG;
    private int WHITE;
    private int TEXT;
    private int SUB;
    private int BLUE;
    private int BLUE_SOFT;
    private int FIELD;
    private int RED;
    private int RED_SOFT;
    private int GREEN;
    private int GREEN_SOFT;
    private int WARN;
    private int WARN_SOFT;
    private int LINE;

    private boolean firstResume = true;
    private boolean refreshProductsOnResume;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable statusRefresh = new Runnable() {
        @Override public void run() {
            if (redirectToGateIfNeeded()) return;
            renderProducts();
            refreshSessionButton();
            handler.postDelayed(this, 2500L);
        }
    };
    private final Runnable resumeRefresh = () -> {
        resumeMonitorIfNeeded();
        if (refreshProductsOnResume) renderProducts();
        refreshSessionButton();
        handler.removeCallbacks(statusRefresh);
        handler.postDelayed(statusRefresh, 2500L);
    };

    private LinearLayout productList;
    private ScrollView productScroll;
    private LinearLayout summaryStrip;
    private View summaryDot;
    private TextView summaryTitle;
    private TextView summaryDetail;
    private FrameLayout summaryActionBox;
    private TextView summaryAction;
    private TextView productCount;
    private final List<String> renderedProductIds = new ArrayList<>();
    private TextView sessionButton;
    private WebView webView;
    private Dialog optionDialog;
    private Dialog addDialog;

    private JSONArray latestOptions = new JSONArray();
    private String latestTitle = "";
    private String latestApiUrl = "";
    private String latestChannelUid = "";
    private String latestProductNo = "";
    private String pendingUrl = "";
    private String editingProductId = null;
    private String pendingEnableProductId = null;
    private boolean pendingEnableAll;
    private boolean autoInspect;
    private boolean loginLaunching;
    private boolean optionLoadInProgress;
    private JSONObject pendingLookupProduct;
    private boolean directLookupAttempt;
    private boolean monitorPausedForOptionLookup;
    private int optionRetryCount;
    private int optionNoContentReloadCount;

    private static final class ProductCardHolder {
        LinearLayout card;
        TextView name;
        ImageView menu;
        LinearLayout badgeBox;
        View badgeDot;
        TextView badgeText;
        TextView state;
        RestockSwitch toggle;
        LinearLayout optionsRow;
        TextView options;
    }

    @Override
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView.setWebContentsDebuggingEnabled(false);
        loadTokens();
        requestNotificationPermissionIfNeeded();
        ProductStore.migrateLegacyIfNeeded(this);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);
        root.setClipChildren(false);
        root.setClipToPadding(false);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int top;
            int bottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                var bars = insets.getInsets(WindowInsets.Type.systemBars());
                top = bars.top;
                bottom = bars.bottom;
            } else {
                top = insets.getSystemWindowInsetTop();
                bottom = insets.getSystemWindowInsetBottom();
            }
            int side = Ui.dim(this, R.dimen.restock_screen_padding);
            view.setPadding(side, top + dp(10), side, bottom + dp(10));
            return insets;
        });

        LinearLayout topRow = new LinearLayout(this);
        topRow.setGravity(Gravity.CENTER_VERTICAL);
        root.addView(topRow, matchWrap());

        ImageView appIcon = new ImageView(this);
        appIcon.setImageResource(R.drawable.restock_icon);
        appIcon.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        topRow.addView(appIcon, new LinearLayout.LayoutParams(dp(34), dp(34)));

        TextView brand = Ui.text(this, "Restock", R.dimen.restock_text_screen_title, TEXT, Typeface.BOLD);
        LinearLayout.LayoutParams brandLp = Ui.wrapWrap();
        brandLp.leftMargin = dp(10);
        topRow.addView(brand, brandLp);

        View spacer = new View(this);
        topRow.addView(spacer, new LinearLayout.LayoutParams(0, dp(1), 1f));

        sessionButton = Ui.text(this, "로그인", R.dimen.restock_text_label, BLUE, Typeface.BOLD);
        sessionButton.setGravity(Gravity.CENTER);
        sessionButton.setPadding(dp(12), 0, dp(12), 0);
        sessionButton.setOnClickListener(v -> handleSessionAction());
        Motion.press(sessionButton);
        topRow.addView(sessionButton, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            Ui.dim(this, R.dimen.restock_touch_min)
        ));

        ImageView settings = new ImageView(this);
        settings.setImageResource(R.drawable.ic_settings);
        settings.setColorFilter(TEXT);
        settings.setContentDescription("설정");
        settings.setPadding(dp(13), dp(13), dp(13), dp(13));
        settings.setOnClickListener(v ->
            Motion.push(this, new Intent(this, SettingsActivity.class))
        );
        Motion.press(settings);
        topRow.addView(settings, new LinearLayout.LayoutParams(
            Ui.dim(this, R.dimen.restock_touch_min),
            Ui.dim(this, R.dimen.restock_touch_min)
        ));
        refreshSessionButton();

        LinearLayout listHeader = new LinearLayout(this);
        listHeader.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams listHeaderLp = Ui.matchWrap();
        listHeaderLp.topMargin = dp(18);
        root.addView(listHeader, listHeaderLp);

        productCount = Ui.text(this, "", R.dimen.restock_text_label, SUB, Typeface.NORMAL);
        listHeader.addView(productCount, new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            1f
        ));

        TextView add = Ui.text(this, "+ 상품 추가", R.dimen.restock_text_body, BLUE, Typeface.BOLD);
        add.setGravity(Gravity.CENTER_VERTICAL);
        add.setPadding(dp(10), 0, 0, 0);
        add.setMinHeight(Ui.dim(this, R.dimen.restock_touch_min));
        add.setOnClickListener(v -> showAddProductDialog());
        Motion.press(add);
        listHeader.addView(add);

        buildSummaryStrip(root);

        FrameLayout productArea = new FrameLayout(this);
        productArea.setClipChildren(false);
        productArea.setClipToPadding(false);
        root.addView(productArea, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            0,
            1f
        ));

        productScroll = new ScrollView(this);
        productScroll.setFillViewport(true);
        productScroll.setClipChildren(true);
        productScroll.setClipToPadding(true);
        productScroll.setPadding(0, 0, 0, dp(12));
        // 우측 점 레일이 뒤로가기 제스처 가장자리와 겹쳐서 기본 스크롤바로 바꿨다.
        productScroll.setVerticalScrollBarEnabled(true);
        productScroll.setScrollBarStyle(View.SCROLLBARS_INSIDE_OVERLAY);
        productScroll.setOverScrollMode(View.OVER_SCROLL_NEVER);
        productArea.addView(productScroll, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));

        productList = new LinearLayout(this);
        productList.setOrientation(LinearLayout.VERTICAL);
        productScroll.addView(productList, matchWrap());

        webView = new WebView(this);
        configureWebView(webView);
        SmartStorePageCapture.install(webView);
        webView.setVisibility(View.INVISIBLE);
        webView.addJavascriptInterface(new InventoryBridge(), "RestockBridge");
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

            @Override public void onPageFinished(WebView view, String url) {
                String siteType = SiteSupport.detect(pendingUrl);
                if (SiteSupport.NAVER_SMARTSTORE.equals(siteType) && SiteSupport.isNaverLoginUrl(url)) {
                    if (!pendingUrl.isBlank()) launchLogin(pendingUrl);
                    return;
                }
                if (SiteSupport.isProductPage(siteType, url) && autoInspect) {
                    autoInspect = false;
                    long delay = SiteSupport.SWAGKEY_IMWEB.equals(siteType) ? 1200L : 700L;
                    handler.postDelayed(MainActivity.this::inspectInventory, delay);
                }
            }
        });
        root.addView(webView, new LinearLayout.LayoutParams(dp(1), dp(1)));

        setContentView(root);
        root.requestApplyInsets();
        Motion.enter(topRow, 0L);
        Motion.enter(listHeader, 35L);
        Motion.enter(summaryStrip, 60L);
        renderProducts(true);
    }

    private void loadTokens() {
        BG = Ui.color(this, R.color.restock_bg);
        WHITE = Ui.color(this, R.color.restock_surface);
        TEXT = Ui.color(this, R.color.restock_ink);
        SUB = Ui.color(this, R.color.restock_ink_2);
        BLUE = Ui.color(this, R.color.restock_accent);
        BLUE_SOFT = Ui.color(this, R.color.restock_accent_soft);
        FIELD = Ui.color(this, R.color.restock_field);
        RED = Ui.color(this, R.color.restock_danger);
        RED_SOFT = Ui.color(this, R.color.restock_danger_soft);
        GREEN = Ui.color(this, R.color.restock_ok);
        GREEN_SOFT = Ui.color(this, R.color.restock_ok_soft);
        WARN = Ui.color(this, R.color.restock_warn);
        WARN_SOFT = Ui.color(this, R.color.restock_warn_soft);
        LINE = Ui.color(this, R.color.restock_line);
    }

    /** 상단 요약 스트립: 감시 중 개수 · 마지막 확인 · 실패 건수 + 전체 켜기/끄기. */
    private void buildSummaryStrip(LinearLayout root) {
        summaryStrip = Ui.surface(this);
        summaryStrip.setPadding(dp(16), dp(14), dp(16), dp(14));
        LinearLayout.LayoutParams stripLp = Ui.matchWrap();
        stripLp.topMargin = dp(12);
        root.addView(summaryStrip, stripLp);

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        summaryStrip.addView(row, Ui.matchWrap());

        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        row.addView(texts, new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            1f
        ));

        LinearLayout titleRow = new LinearLayout(this);
        titleRow.setGravity(Gravity.CENTER_VERTICAL);
        texts.addView(titleRow, Ui.matchWrap());

        summaryDot = Ui.dot(this, GREEN, 8);
        LinearLayout.LayoutParams dotLp = Ui.fixed(dp(8), dp(8));
        dotLp.rightMargin = dp(8);
        titleRow.addView(summaryDot, dotLp);

        summaryTitle = Ui.text(this, "", R.dimen.restock_text_card_title, TEXT, Typeface.BOLD);
        titleRow.addView(summaryTitle);

        summaryDetail = Ui.text(this, "", R.dimen.restock_text_label, SUB, Typeface.NORMAL);
        summaryDetail.setSingleLine(true);
        summaryDetail.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams detailLp = Ui.matchWrap();
        detailLp.topMargin = dp(4);
        texts.addView(summaryDetail, detailLp);

        summaryActionBox = new FrameLayout(this);
        summaryActionBox.setMinimumHeight(Ui.dim(this, R.dimen.restock_touch_min));
        LinearLayout.LayoutParams actionLp = Ui.wrapWrap();
        actionLp.leftMargin = dp(12);
        row.addView(summaryActionBox, actionLp);

        summaryAction = Ui.text(this, "", R.dimen.restock_text_label, BLUE, Typeface.BOLD);
        summaryAction.setGravity(Gravity.CENTER);
        summaryAction.setPadding(dp(14), 0, dp(14), 0);
        summaryActionBox.addView(summaryAction, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Ui.dim(this, R.dimen.restock_ghost_height),
            Gravity.CENTER
        ));
        summaryAction.setBackground(Ui.outline(this, WHITE, BLUE, 17, 1));
        summaryActionBox.setOnClickListener(v -> handleSummaryAction());
        Motion.press(summaryActionBox);
    }

    private void handleSummaryAction() {
        JSONArray products = ProductStore.list(this);
        if (products.length() == 0) {
            showAddProductDialog();
            return;
        }
        if (ProductStore.enabledCount(this) > 0) disableAllProducts();
        else enableAllProducts();
    }

    private void bindSummary(JSONArray products) {
        if (summaryTitle == null) return;
        int total = products == null ? 0 : products.length();
        int enabled = ProductStatus.enabledCount(products);
        int failures = ProductStatus.failureCount(products);
        long now = System.currentTimeMillis();
        long lastCheck = ProductStatus.latestCheck(products);

        if (enabled <= 0) {
            summaryTitle.setText(total == 0 ? "등록된 상품 없음" : "감시 중지됨");
            summaryDot.setBackground(Ui.roundRect(this, Ui.color(this, R.color.restock_track_off), 4));
            if (total == 0) {
                summaryDetail.setText("상품을 추가하면 재입고를 확인해요");
                summaryAction.setText("+ 상품 추가");
            } else {
                summaryDetail.setText(lastCheck > 0L
                    ? "마지막 확인 " + ProductStatus.relativeTime(lastCheck, now)
                    : "알림을 켜면 재입고를 확인해요");
                summaryAction.setText("전체 켜기");
            }
        } else {
            summaryTitle.setText("감시 중 " + enabled + "개");
            summaryDot.setBackground(Ui.roundRect(this, failures > 0 ? RED : GREEN, 4));
            SpannableStringBuilder detail = new SpannableStringBuilder();
            detail.append("마지막 확인 ")
                .append(lastCheck > 0L ? ProductStatus.relativeTime(lastCheck, now) : "대기 중");
            if (failures > 0) {
                detail.append(" · ");
                int start = detail.length();
                detail.append("실패 ").append(String.valueOf(failures)).append("건");
                detail.setSpan(
                    new ForegroundColorSpan(RED),
                    start,
                    detail.length(),
                    Spannable.SPAN_EXCLUSIVE_EXCLUSIVE
                );
            }
            summaryDetail.setText(detail);
            summaryAction.setText("전체 끄기");
        }
    }

    private void handleSessionAction() {
        if (!hasNaverSession()) {
            openLoginForExistingProduct();
            return;
        }
        new AlertDialog.Builder(this)
            .setTitle("로그아웃할까요?")
            .setMessage("켜진 재입고 알림도 함께 꺼져요.")
            .setNegativeButton("취소", null)
            .setPositiveButton("로그아웃", (d, w) -> {
                ProductStore.disableSite(this, SiteSupport.NAVER_SMARTSTORE);
                syncMonitorService();
                clearAppLogin();
            })
            .show();
    }

    private boolean hasNaverSession() {
        return SessionState.hasUsableNaverSession(this);
    }

    private boolean redirectToGateIfNeeded() {
        if (loginLaunching || !SessionState.shouldShowGate(this)) return false;
        Intent intent = new Intent(this, GateActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent);
        finish();
        return true;
    }

    private void refreshSessionButton() {
        if (sessionButton == null) return;
        boolean loggedIn = hasNaverSession();
        sessionButton.setText(loggedIn ? "로그아웃" : "로그인");
        sessionButton.setTextColor(loggedIn ? SUB : BLUE);
        sessionButton.setBackground(null);
    }

    private boolean optionFlowBusy() {
        return optionLoadInProgress || (optionDialog != null && optionDialog.isShowing());
    }

    private void showAddProductDialog() {
        if (optionFlowBusy()) {
            toast("옵션을 불러오는 중이에요.");
            return;
        }
        if (addDialog != null && addDialog.isShowing()) return;

        Dialog dialog = new Dialog(this);
        addDialog = dialog;
        LinearLayout panel = surface(24, 20);

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        panel.addView(header, matchWrap());
        header.addView(text("상품 추가", 20, TEXT, Typeface.BOLD), new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            1f
        ));
        TextView close = text("닫기", 15, SUB, Typeface.BOLD);
        close.setPadding(dp(12), dp(8), 0, dp(8));
        close.setOnClickListener(v -> Motion.dismissDialog(dialog, panel));
        Motion.press(close);
        header.addView(close);

        TextView label = text("상품 주소", 13, SUB, Typeface.NORMAL);
        label.setPadding(0, dp(16), 0, dp(8));
        panel.addView(label);

        LinearLayout field = new LinearLayout(this);
        field.setGravity(Gravity.CENTER_VERTICAL);
        field.setPadding(dp(14), 0, dp(8), 0);
        field.setBackground(roundRect(FIELD, 14));
        panel.addView(field, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(52)
        ));

        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setTextSize(14);
        input.setTextColor(TEXT);
        input.setHintTextColor(SUB);
        input.setHint("SmartStore 또는 SWAGKEY 상품 링크");
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setBackgroundColor(Color.TRANSPARENT);
        input.setPadding(0, 0, dp(8), 0);
        field.addView(input, new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.MATCH_PARENT,
            1f
        ));

        String clipboardUrl = readClipboardProductUrl();
        ImageView paste = new ImageView(this);
        paste.setImageResource(R.drawable.ic_clipboard);
        paste.setPadding(dp(9), dp(9), dp(9), dp(9));
        paste.setColorFilter(clipboardUrl.isBlank() ? SUB : BLUE);
        paste.setAlpha(clipboardUrl.isBlank() ? 0.55f : 1f);
        field.addView(paste, new LinearLayout.LayoutParams(dp(42), dp(42)));
        Motion.press(paste);
        paste.setOnClickListener(v -> {
            String value = readClipboardProductUrl();
            if (value.isBlank()) {
                toast("클립보드에 지원하는 상품 링크가 없어요.");
                return;
            }
            input.setText(value);
            input.setSelection(value.length());
            Motion.selection(paste);
        });

        TextView load = text("상품 불러오기", 15, Color.WHITE, Typeface.BOLD);
        load.setGravity(Gravity.CENTER);
        load.setPadding(0, dp(14), 0, dp(14));
        LinearLayout.LayoutParams loadLp = matchWrap();
        loadLp.topMargin = dp(18);
        panel.addView(load, loadLp);
        updateLoadButton(load, input.getText().toString());
        input.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {
                updateLoadButton(load, s == null ? "" : s.toString());
            }
            @Override public void afterTextChanged(Editable s) {}
        });
        Motion.press(load);
        load.setOnClickListener(v -> {
            String url = input.getText().toString().trim();
            if (!SiteSupport.isSupportedProductUrl(url)) return;
            Motion.dismissDialog(dialog, panel, () -> loadProductForEdit(url, null));
        });

        dialog.setContentView(panel);
        dialog.setCancelable(true);
        dialog.setOnDismissListener(d -> addDialog = null);
        dialog.show();
        sizeDialog(dialog, 0.92f);
        Motion.dialogIn(panel);
    }

    private String readClipboardProductUrl() {
        try {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (clipboard == null || !clipboard.hasPrimaryClip()) return "";
            ClipData clip = clipboard.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return "";
            CharSequence text = clip.getItemAt(0).coerceToText(this);
            String value = text == null ? "" : text.toString().trim();
            return SiteSupport.isSupportedProductUrl(value) ? value : "";
        } catch (Exception ignored) {
            return "";
        }
    }

    private void updateLoadButton(TextView button, String value) {
        boolean valid = SiteSupport.isSupportedProductUrl(value == null ? "" : value.trim());
        button.setBackground(roundRect(valid ? BLUE : Ui.color(this, R.color.restock_disabled), 14));
        button.setAlpha(valid ? 1f : 0.7f);
    }

    private void editProduct(JSONObject product) {
        if (product.optBoolean("enabled", false)) {
            toast("알림을 끈 뒤 옵션을 수정해주세요.");
            return;
        }
        if (optionFlowBusy()) {
            toast("옵션을 불러오는 중이에요.");
            return;
        }
        loadProductForEdit(product.optString("url"), product.optString("id"));
    }

    private void loadProductForEdit(String url, String id) {
        if (!SiteSupport.isSupportedProductUrl(url)) {
            toast("지원하는 상품 URL인지 확인해주세요.");
            return;
        }
        if (optionFlowBusy()) return;

        JSONObject existing = id == null
            ? ProductStore.find(this, ProductStore.idFromUrl(url))
            : ProductStore.find(this, id);

        optionLoadInProgress = true;
        pendingUrl = url;
        editingProductId = id;
        pendingLookupProduct = existing;
        directLookupAttempt = false;
        optionRetryCount = 0;
        optionNoContentReloadCount = 0;
        latestOptions = new JSONArray();
        latestTitle = existing == null ? "" : existing.optString("title", "");
        latestApiUrl = existing == null ? "" : existing.optString("apiUrl", "");
        latestChannelUid = existing == null ? "" : existing.optString("channelUid", "");
        latestProductNo = existing == null ? "" : existing.optString("productNo", "");
        autoInspect = true;
        boolean pausedMonitor = SiteSupport.NAVER_SMARTSTORE.equals(SiteSupport.detect(url))
            && pauseMonitorForOptionLookup();
        webView.stopLoading();
        if (pausedMonitor) {
            handler.postDelayed(() -> {
                if (!optionLoadInProgress || !url.equals(pendingUrl)) return;
                webView.loadUrl(url);
            }, 350L);
        } else {
            webView.loadUrl(url);
        }
    }

    private void inspectInventory() {
        if (!optionLoadInProgress) return;
        String siteType = SiteSupport.detect(pendingUrl);
        String currentUrl = webView.getUrl();
        if (!SiteSupport.isSameProductPage(siteType, pendingUrl, currentUrl)) {
            DiagnosticLog.add(this, "OPTION_PAGE_MISMATCH", pendingLookupProduct, safeHost(currentUrl));
            optionLoadInProgress = false;
            resumeMonitorAfterOptionLookup();
            clearPendingEdit();
            toast("상품 페이지를 확인하지 못했어요.");
            return;
        }

        if (SiteSupport.SWAGKEY_IMWEB.equals(siteType)) {
            directLookupAttempt = false;
            webView.evaluateJavascript(SwagkeyScript.SCRIPT, ignored -> {});
            return;
        }

        // SmartStore's internal product API can return an empty 204 even when
        // the product page itself loaded correctly. Read the page state first
        // for both new and existing products instead of using a saved API URL.
        runSmartStoreDiscovery();
    }

    private void runSmartStoreDiscovery() {
        if (!optionLoadInProgress) return;
        directLookupAttempt = false;
        boolean allowApiFallback = MonitorService.remainingSmartStoreRateLimitMillis(this) <= 0L;
        webView.evaluateJavascript(
            InventoryScript.build(pendingLookupProduct, allowApiFallback),
            ignored -> {}
        );
    }

    private class InventoryBridge {
        @JavascriptInterface public void onResult(String json) {
            runOnUiThread(() -> handleInventory(json));
        }
    }

    private void handleInventory(String json) {
        if (!optionLoadInProgress) return;
        try {
            JSONObject result = new JSONObject(json);
            if (!isOptionResultForPendingProduct(result)) {
                DiagnosticLog.add(
                    this,
                    "OPTION_STALE_RESULT",
                    pendingLookupProduct,
                    result.optString(
                        "productId",
                        result.optString("productNo", result.optString("pageUrl", "unknown"))
                    )
                );
                return;
            }
            if (!result.optBoolean("ok")) {
                int status = result.optInt("status", 0);
                String error = result.optString("error", "UNKNOWN");
                String siteType = SiteSupport.detect(pendingUrl);
                boolean authFailure = SiteSupport.NAVER_SMARTSTORE.equals(siteType)
                    && SessionState.isInventoryAuthenticationFailure(
                        error, status, SiteSupport.isNaverLoginUrl(webView.getUrl()),
                        hasNaverSession());
                if (authFailure && !pendingUrl.isBlank()) {
                    DiagnosticLog.add(this, "OPTION_LOGIN_REQUIRED", pendingLookupProduct, error);
                    directLookupAttempt = false;
                    launchLogin(pendingUrl);
                } else if (SiteSupport.NAVER_SMARTSTORE.equals(siteType)
                    && "API_DEFERRED".equals(error)) {
                    handleOptionRateLimitWait();
                } else if (SiteSupport.NAVER_SMARTSTORE.equals(siteType)
                    && ("NO_CONTENT".equals(error) || status == 204)) {
                    if (InventoryRetry.shouldReloadNoContent(error, status, optionNoContentReloadCount)) {
                        optionNoContentReloadCount++;
                        DiagnosticLog.add(
                            this,
                            "OPTION_NO_CONTENT_RETRY",
                            pendingLookupProduct,
                            "HTTP 204 · 페이지 재로드 후 1회 재확인"
                        );
                        autoInspect = true;
                        String retryUrl = pendingUrl;
                        handler.postDelayed(() -> {
                            if (!optionLoadInProgress || retryUrl.isBlank() || !retryUrl.equals(pendingUrl)) return;
                            webView.stopLoading();
                            webView.loadUrl(retryUrl);
                        }, 700L);
                    } else {
                        DiagnosticLog.add(this, "OPTION_NO_CONTENT", pendingLookupProduct, "HTTP 204 · 상품 데이터 없음");
                        optionLoadInProgress = false;
                        resumeMonitorAfterOptionLookup();
                        clearPendingEdit();
                        toast("상품 페이지에서 옵션 정보를 찾지 못했어요.");
                    }
                } else if (SiteSupport.NAVER_SMARTSTORE.equals(siteType)
                    && ("RATE_LIMITED".equals(error) || status == 429)) {
                    handleOptionRateLimit(status);
                } else if (SiteSupport.NAVER_SMARTSTORE.equals(siteType)
                    && directLookupAttempt
                    && InventoryRetry.shouldRediscoverDirect(error, status)) {
                    DiagnosticLog.add(this, "OPTION_CHECK_RETRY", pendingLookupProduct, error);
                    runSmartStoreDiscovery();
                } else if (InventoryRetry.shouldRetryInteractive(error, status)
                    && optionRetryCount < 1) {
                    optionRetryCount++;
                    DiagnosticLog.add(
                        this,
                        "OPTION_CHECK_RETRY",
                        pendingLookupProduct,
                        error + (status > 0 ? " · HTTP " + status : "") + " · 1/1"
                    );
                    autoInspect = true;
                    String retryUrl = pendingUrl;
                    handler.postDelayed(() -> {
                        if (!optionLoadInProgress || retryUrl.isBlank() || !retryUrl.equals(pendingUrl)) return;
                        webView.stopLoading();
                        webView.loadUrl(retryUrl);
                    }, 1_500L);
                } else {
                    DiagnosticLog.add(this, "OPTION_CHECK_FAIL", pendingLookupProduct, error + (status > 0 ? " · HTTP " + status : ""));
                    optionLoadInProgress = false;
                    resumeMonitorAfterOptionLookup();
                    clearPendingEdit();
                    toast("옵션 조회에 실패했어요.");
                }
                return;
            }

            String siteType = SiteSupport.detect(pendingUrl);
            latestTitle = result.optString("title", SiteSupport.label(siteType) + " 상품");
            latestOptions = result.optJSONArray("options");
            String apiUrl = result.optString("apiUrl", "");
            String channelUid = result.optString("channelUid", "");
            String productNo = result.optString("productNo", "");
            if (!apiUrl.isBlank()) latestApiUrl = apiUrl;
            if (!channelUid.isBlank()) latestChannelUid = channelUid;
            if (!productNo.isBlank()) latestProductNo = productNo;
            if (latestOptions == null || latestOptions.length() == 0) {
                DiagnosticLog.add(this, "OPTION_CHECK_FAIL", pendingLookupProduct,
                    "OPTION_LIST_EMPTY");
                optionLoadInProgress = false;
                resumeMonitorAfterOptionLookup();
                clearPendingEdit();
                toast("선택 가능한 옵션이 없어요.");
                return;
            }
            if (SiteSupport.NAVER_SMARTSTORE.equals(siteType)) {
                String source = result.optString("source", "");
                if ("PAGE_CAPTURE".equals(source)) {
                    DiagnosticLog.add(this, "OPTION_PAGE_CAPTURE_OK", pendingLookupProduct,
                        "상품 API 응답 재사용 · 옵션 " + latestOptions.length() + "개 · " + optionSummary(latestOptions));
                } else if ("PAGE_STATE".equals(source)) {
                    String match = result.optBoolean("exactProductMatch", false)
                        ? "상품번호 일치"
                        : "상품명 일치 후보";
                    DiagnosticLog.add(this, "OPTION_PAGE_STATE_OK", pendingLookupProduct,
                        match + " · 옵션 " + latestOptions.length() + "개 · " + optionSummary(latestOptions));
                }
            } else if (SiteSupport.SWAGKEY_IMWEB.equals(siteType)
                && "SWAGKEY_DOM".equals(result.optString("source", ""))) {
                DiagnosticLog.add(this, "OPTION_SWAGKEY_DOM_OK", pendingLookupProduct,
                    "상품 옵션 " + latestOptions.length() + "개 · " + optionSummary(latestOptions));
            }
            resumeMonitorAfterOptionLookup();
            showOptionPicker();
        } catch (Exception e) {
            optionLoadInProgress = false;
            resumeMonitorAfterOptionLookup();
            clearPendingEdit();
            toast("상품 정보를 처리하지 못했어요.");
        }
    }

    private boolean isOptionResultForPendingProduct(JSONObject result) {
        if (result == null || pendingUrl == null || pendingUrl.isBlank()) return false;
        String expectedId = ProductStore.idFromUrl(pendingUrl);
        String resultProductId = result.optString("productId", "");
        if (resultProductId.isBlank()) resultProductId = result.optString("productNo", "");
        if (!resultProductId.isBlank()) return expectedId.equals(resultProductId);

        String pageUrl = result.optString("pageUrl", "");
        if (!pageUrl.isBlank()) {
            return SiteSupport.isSameProductPage(SiteSupport.detect(pendingUrl), pendingUrl, pageUrl);
        }
        return false;
    }

    private void handleOptionRateLimitWait() {
        long remaining = MonitorService.remainingSmartStoreRateLimitMillis(this);
        if (remaining <= 0L) {
            runSmartStoreDiscovery();
            return;
        }
        long seconds = Math.max(1L, (remaining + 999L) / 1000L);
        DiagnosticLog.add(this, "OPTION_RATE_LIMIT_WAIT", pendingLookupProduct, seconds + "초 남음");
        optionLoadInProgress = false;
        resumeMonitorAfterOptionLookup();
        clearPendingEdit();
        toast("네이버 요청 제한 대기 중 · " + seconds + "초 후 다시 시도해주세요.");
    }

    private void handleOptionRateLimit(int status) {
        long until = MonitorService.extendSmartStoreRateLimit(this, status);
        long seconds = Math.max(1L, (until - System.currentTimeMillis() + 999L) / 1000L);
        String statusText = status > 0 ? "HTTP " + status : "RATE_LIMITED";
        DiagnosticLog.add(this, "OPTION_RATE_LIMIT", pendingLookupProduct, statusText + " · " + seconds + "초 대기");
        optionLoadInProgress = false;
        resumeMonitorAfterOptionLookup();
        clearPendingEdit();
        toast("네이버 요청 제한 · " + seconds + "초 후 다시 시도해주세요.");
    }

    private String optionSummary(JSONArray options) {
        StringBuilder summary = new StringBuilder();
        int count = Math.min(options == null ? 0 : options.length(), 3);
        for (int i = 0; i < count; i++) {
            if (summary.length() > 0) summary.append(" | ");
            summary.append(optionLabel(options.optJSONObject(i)));
        }
        if (options != null && options.length() > count) summary.append(" 외 ").append(options.length() - count).append("개");
        return summary.toString();
    }

    private boolean pauseMonitorForOptionLookup() {
        if (monitorPausedForOptionLookup) return true;
        if (ProductStore.enabledCount(this) <= 0 || !isRunning()) return false;
        monitorPausedForOptionLookup = true;
        startService(new Intent(this, MonitorService.class)
            .setAction(MonitorService.ACTION_PAUSE_OPTION_LOOKUP));
        return true;
    }

    private void resumeMonitorAfterOptionLookup() {
        if (!monitorPausedForOptionLookup) return;
        monitorPausedForOptionLookup = false;
        if (ProductStore.enabledCount(this) > 0) {
            startService(new Intent(this, MonitorService.class)
                .setAction(MonitorService.ACTION_RESUME_OPTION_LOOKUP));
        }
    }

    private void showOptionPicker() {
        if (optionDialog != null && optionDialog.isShowing()) return;

        final String targetUrl = pendingUrl;
        final String targetEditingId = editingProductId;
        final String titleSnapshot = latestTitle;
        final String apiUrlSnapshot = latestApiUrl;
        final String channelUidSnapshot = latestChannelUid;
        final String productNoSnapshot = latestProductNo;
        final JSONArray optionsSnapshot = latestOptions;

        JSONObject existing = targetEditingId == null
            ? ProductStore.find(this, ProductStore.idFromUrl(targetUrl))
            : ProductStore.find(this, targetEditingId);
        Set<String> saved = new HashSet<>();
        if (existing != null) {
            JSONArray ids = existing.optJSONArray("selectedIds");
            if (ids != null) {
                for (int i = 0; i < ids.length(); i++) saved.add(ids.optString(i));
            }
        }

        boolean[] checked = new boolean[optionsSnapshot.length()];
        for (int i = 0; i < optionsSnapshot.length(); i++) {
            JSONObject option = optionsSnapshot.optJSONObject(i);
            checked[i] = option != null && saved.contains(option.optString("id"));
        }

        Dialog dialog = new Dialog(this);
        optionDialog = dialog;
        optionLoadInProgress = false;
        boolean[] committed = {false};
        boolean[] selectedOnly = {false};
        Set<String> collapsedGroups = new HashSet<>();

        LinearLayout panel = surface(24, 20);

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        panel.addView(header, matchWrap());
        header.addView(text("옵션 선택", 20, TEXT, Typeface.BOLD), new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            1f
        ));
        TextView close = text("닫기", 15, SUB, Typeface.BOLD);
        close.setPadding(dp(12), dp(8), 0, dp(8));
        close.setOnClickListener(v -> Motion.dismissDialog(dialog, panel));
        Motion.press(close);
        header.addView(close);

        TextView productName = text(titleSnapshot, 13, SUB, Typeface.NORMAL);
        productName.setPadding(0, dp(5), 0, dp(12));
        panel.addView(productName);

        EditText search = new EditText(this);
        search.setSingleLine(true);
        search.setTextSize(14);
        search.setTextColor(TEXT);
        search.setHintTextColor(SUB);
        search.setHint("옵션 검색");
        search.setBackground(roundRect(FIELD, 14));
        search.setPadding(dp(14), 0, dp(14), 0);
        panel.addView(search, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(48)
        ));

        LinearLayout filterRow = new LinearLayout(this);
        filterRow.setGravity(Gravity.CENTER_VERTICAL);
        filterRow.setPadding(0, dp(10), 0, dp(8));
        panel.addView(filterRow, matchWrap());

        TextView allChip = text("전체", 13, BLUE, Typeface.BOLD);
        allChip.setGravity(Gravity.CENTER);
        allChip.setPadding(dp(13), dp(8), dp(13), dp(8));
        filterRow.addView(allChip);
        TextView selectedChip = text("선택만", 13, SUB, Typeface.BOLD);
        selectedChip.setGravity(Gravity.CENTER);
        selectedChip.setPadding(dp(13), dp(8), dp(13), dp(8));
        LinearLayout.LayoutParams selectedLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        selectedLp.leftMargin = dp(7);
        filterRow.addView(selectedChip, selectedLp);
        TextView selectedCount = text("", 13, BLUE, Typeface.BOLD);
        selectedCount.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        filterRow.addView(selectedCount, new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            1f
        ));

        ScrollView scroll = new ScrollView(this);
        LinearLayout optionList = new LinearLayout(this);
        optionList.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(optionList);
        panel.addView(scroll, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(390)
        ));

        Motion.press(allChip);
        Motion.press(selectedChip);
        allChip.setOnClickListener(v -> {
            selectedOnly[0] = false;
            renderOptionList(optionList, optionsSnapshot, checked, search, selectedOnly, collapsedGroups, selectedCount, allChip, selectedChip);
        });
        selectedChip.setOnClickListener(v -> {
            selectedOnly[0] = true;
            renderOptionList(optionList, optionsSnapshot, checked, search, selectedOnly, collapsedGroups, selectedCount, allChip, selectedChip);
        });
        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {
                renderOptionList(optionList, optionsSnapshot, checked, search, selectedOnly, collapsedGroups, selectedCount, allChip, selectedChip);
            }
            @Override public void afterTextChanged(Editable s) {}
        });
        renderOptionList(optionList, optionsSnapshot, checked, search, selectedOnly, collapsedGroups, selectedCount, allChip, selectedChip);

        TextView save = text("저장", 15, Color.WHITE, Typeface.BOLD);
        save.setGravity(Gravity.CENTER);
        save.setBackground(roundRect(BLUE, 14));
        save.setPadding(0, dp(14), 0, dp(14));
        LinearLayout.LayoutParams saveLp = matchWrap();
        saveLp.topMargin = dp(10);
        panel.addView(save, saveLp);
        Motion.press(save);
        save.setOnClickListener(v -> {
            if (saveProductSelection(
                checked,
                targetUrl,
                targetEditingId,
                titleSnapshot,
                apiUrlSnapshot,
                channelUidSnapshot,
                productNoSnapshot,
                optionsSnapshot
            )) {
                committed[0] = true;
                Motion.dismissDialog(dialog, panel, () -> renderProducts(true));
            }
        });

        dialog.setContentView(panel);
        dialog.setCancelable(true);
        dialog.setOnDismissListener(d -> {
            optionDialog = null;
            optionLoadInProgress = false;
            if (!committed[0]) clearPendingEdit();
        });
        dialog.show();
        sizeDialog(dialog, 0.94f);
        Motion.dialogIn(panel);
    }

    private void renderOptionList(
        LinearLayout container,
        JSONArray options,
        boolean[] checked,
        EditText search,
        boolean[] selectedOnly,
        Set<String> collapsedGroups,
        TextView selectedCount,
        TextView allChip,
        TextView selectedChip
    ) {
        container.removeAllViews();
        updateSelectedCount(selectedCount, checked);
        allChip.setTextColor(selectedOnly[0] ? SUB : BLUE);
        selectedChip.setTextColor(selectedOnly[0] ? BLUE : SUB);
        allChip.setBackground(roundRect(selectedOnly[0] ? FIELD : BLUE_SOFT, 12));
        selectedChip.setBackground(roundRect(selectedOnly[0] ? BLUE_SOFT : FIELD, 12));

        String query = search.getText() == null
            ? ""
            : search.getText().toString().trim().toLowerCase(Locale.ROOT);
        boolean grouped = hasSubOptions(options);
        Map<String, List<Integer>> groups = new LinkedHashMap<>();

        for (int i = 0; i < options.length(); i++) {
            JSONObject option = options.optJSONObject(i);
            if (option == null) continue;
            if (selectedOnly[0] && !checked[i]) continue;
            String label = optionLabel(option);
            if (!query.isBlank() && !label.toLowerCase(Locale.ROOT).contains(query)) continue;
            String group = grouped ? option.optString("optionName1", "옵션") : "옵션";
            if (group.isBlank() || "null".equals(group)) group = "옵션";
            groups.computeIfAbsent(group, ignored -> new ArrayList<>()).add(i);
        }

        if (groups.isEmpty()) {
            TextView empty = text(selectedOnly[0] ? "선택한 옵션이 없어요" : "검색 결과가 없어요", 13, SUB, Typeface.NORMAL);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(0, dp(36), 0, dp(36));
            container.addView(empty, matchWrap());
            return;
        }

        for (Map.Entry<String, List<Integer>> entry : groups.entrySet()) {
            String group = entry.getKey();
            List<Integer> indexes = entry.getValue();
            boolean collapsed = query.isBlank() && collapsedGroups.contains(group);

            if (grouped) {
                LinearLayout groupRow = new LinearLayout(this);
                groupRow.setGravity(Gravity.CENTER_VERTICAL);
                groupRow.setPadding(dp(2), dp(10), dp(2), dp(9));
                TextView groupTitle = text(group + "  " + indexes.size(), 15, TEXT, Typeface.BOLD);
                groupRow.addView(groupTitle, new LinearLayout.LayoutParams(
                    0,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    1f
                ));
                TextView arrow = text(collapsed ? "›" : "⌄", 20, SUB, Typeface.NORMAL);
                groupRow.addView(arrow);
                Motion.press(groupRow);
                groupRow.setOnClickListener(v -> {
                    if (collapsedGroups.contains(group)) collapsedGroups.remove(group);
                    else collapsedGroups.add(group);
                    renderOptionList(container, options, checked, search, selectedOnly, collapsedGroups, selectedCount, allChip, selectedChip);
                });
                container.addView(groupRow, matchWrap());
            }

            if (collapsed) continue;
            for (int index : indexes) {
                JSONObject option = options.optJSONObject(index);
                int stock = option == null || option.isNull("stockQuantity")
                    ? -1
                    : option.optInt("stockQuantity", -1);

                LinearLayout row = new LinearLayout(this);
                row.setGravity(Gravity.CENTER_VERTICAL);
                row.setPadding(dp(14), dp(11), dp(14), dp(11));
                row.setBackground(roundRect(checked[index] ? BLUE_SOFT : FIELD, 14));
                LinearLayout.LayoutParams rowLp = matchWrap();
                rowLp.bottomMargin = dp(7);
                container.addView(row, rowLp);

                LinearLayout left = new LinearLayout(this);
                left.setOrientation(LinearLayout.VERTICAL);
                row.addView(left, new LinearLayout.LayoutParams(
                    0,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    1f
                ));
                String displayLabel = grouped ? optionSubLabel(option) : optionLabel(option);
                left.addView(text(displayLabel, 15, TEXT, Typeface.BOLD));
                boolean available = option != null && option.optBoolean("available", false);
                String stockLabel = stock > 0 && !available ? "재고 " + stock + "개 · 구매 불가"
                    : stock > 0 ? "재고 " + stock + "개" : stock == 0 ? "품절" : "재고 확인 중";
                TextView stockView = text(stockLabel, 12, stock > 0 && available ? GREEN : SUB, Typeface.NORMAL);
                stockView.setPadding(0, dp(3), 0, 0);
                left.addView(stockView);

                TextView mark = text(checked[index] ? "✓" : "", 17, BLUE, Typeface.BOLD);
                mark.setGravity(Gravity.CENTER);
                mark.setPadding(dp(12), 0, 0, 0);
                row.addView(mark);
                Motion.press(row);
                row.setOnClickListener(v -> {
                    checked[index] = !checked[index];
                    renderOptionList(container, options, checked, search, selectedOnly, collapsedGroups, selectedCount, allChip, selectedChip);
                });
            }
        }
    }

    private boolean hasSubOptions(JSONArray options) {
        for (int i = 0; i < options.length(); i++) {
            JSONObject option = options.optJSONObject(i);
            if (option == null) continue;
            String second = option.optString("optionName2", "");
            String third = option.optString("optionName3", "");
            if ((!second.isBlank() && !"null".equals(second)) || (!third.isBlank() && !"null".equals(third))) return true;
        }
        return false;
    }

    private String optionSubLabel(JSONObject option) {
        if (option == null) return "옵션";
        StringBuilder label = new StringBuilder();
        for (String key : new String[]{"optionName2", "optionName3"}) {
            String value = option.optString(key, "");
            if (value.isBlank() || "null".equals(value)) continue;
            if (label.length() > 0) label.append(" / ");
            label.append(value);
        }
        return label.length() == 0 ? optionLabel(option) : label.toString();
    }

    private void updateSelectedCount(TextView view, boolean[] checked) {
        int count = 0;
        for (boolean value : checked) if (value) count++;
        view.setText(count + "개 선택");
    }

    private boolean saveProductSelection(
        boolean[] checked,
        String targetUrl,
        String targetEditingId,
        String title,
        String apiUrl,
        String channelUid,
        String productNo,
        JSONArray options
    ) {
        JSONArray ids = new JSONArray();
        JSONObject labels = new JSONObject();
        try {
            for (int i = 0; i < checked.length; i++) {
                if (!checked[i]) continue;
                JSONObject option = options.optJSONObject(i);
                if (option == null) continue;
                String id = option.optString("id");
                if (id.isBlank()) continue;
                ids.put(id);
                labels.put(id, optionLabel(option));
            }
            if (ids.length() == 0) {
                toast("옵션을 하나 이상 선택해주세요.");
                return false;
            }
            if (targetUrl == null || targetUrl.isBlank()) return false;

            JSONObject product = new JSONObject();
            product.put("id", targetEditingId == null || targetEditingId.isBlank()
                ? ProductStore.idFromUrl(targetUrl)
                : targetEditingId);
            product.put("url", targetUrl);
            product.put("title", title);
            product.put("selectedIds", ids);
            product.put("selectedLabels", labels);
            product.put("apiUrl", apiUrl);
            product.put("channelUid", channelUid);
            product.put("productNo", productNo);
            product.put("siteType", SiteSupport.detect(targetUrl));
            ProductStore.upsert(this, product);
            clearPendingEdit();
            return true;
        } catch (Exception e) {
            toast("저장하지 못했어요.");
            return false;
        }
    }

    private void clearPendingEdit() {
        editingProductId = null;
        pendingUrl = "";
        pendingLookupProduct = null;
        directLookupAttempt = false;
        latestOptions = new JSONArray();
        latestTitle = "";
        latestApiUrl = "";
        latestChannelUid = "";
        latestProductNo = "";
        autoInspect = false;
    }

    private void renderProducts() {
        renderProducts(false);
    }

    private void renderProducts(boolean animate) {
        if (productList == null) return;
        int oldScroll = productScroll == null ? 0 : productScroll.getScrollY();
        JSONArray products = ProductStore.list(this);

        bindSummary(products);
        if (productCount != null) productCount.setText("상품 " + products.length() + "개");

        if (!animate && products.length() == 0 && productList.getChildCount() == 1
            && productList.getChildAt(0).getTag() == EMPTY_STATE_TAG) {
            return;
        }
        if (!animate && canReuseProductCards(products)) {
            updateProductCards(products);
            return;
        }

        productList.removeAllViews();
        renderedProductIds.clear();

        if (products.length() == 0) {
            LinearLayout empty = Ui.surface(this);
            empty.setPadding(dp(20), dp(24), dp(20), dp(24));
            TextView value = Ui.text(this, "등록된 상품이 없어요", R.dimen.restock_text_body, SUB, Typeface.NORMAL);
            value.setGravity(Gravity.CENTER);
            empty.addView(value, matchWrap());

            TextView add = Ui.text(this, "+ 상품 추가", R.dimen.restock_text_body, WHITE, Typeface.BOLD);
            add.setGravity(Gravity.CENTER);
            add.setBackground(roundRect(BLUE, 12));
            add.setOnClickListener(v -> showAddProductDialog());
            Motion.press(add);
            LinearLayout.LayoutParams addLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                Ui.dim(this, R.dimen.restock_touch_min)
            );
            addLp.topMargin = dp(14);
            empty.addView(add, addLp);

            empty.setTag(EMPTY_STATE_TAG);
            productList.addView(empty, sectionParams());
            if (animate) Motion.enter(empty, 20L);
            return;
        }

        for (int i = 0; i < products.length(); i++) {
            JSONObject product = products.optJSONObject(i);
            if (product == null) continue;

            ProductCardHolder holder = createProductCard();
            holder.card.setTag(holder);
            bindProductCard(holder, product);
            productList.addView(holder.card, sectionParams());
            renderedProductIds.add(product.optString("id", ""));
            if (animate) Motion.enter(holder.card, 35L + Math.min(i, 6) * 34L);
        }

        if (productScroll != null) {
            productScroll.post(() -> productScroll.scrollTo(0, oldScroll));
        }
    }

    private boolean canReuseProductCards(JSONArray products) {
        if (products == null || products.length() == 0) return false;
        if (products.length() != renderedProductIds.size()) return false;
        if (productList.getChildCount() != products.length()) return false;

        for (int i = 0; i < products.length(); i++) {
            JSONObject product = products.optJSONObject(i);
            if (product == null) return false;
            if (!renderedProductIds.get(i).equals(product.optString("id", ""))) return false;
            if (!(productList.getChildAt(i).getTag() instanceof ProductCardHolder)) return false;
        }
        return true;
    }

    private void updateProductCards(JSONArray products) {
        for (int i = 0; i < products.length(); i++) {
            JSONObject product = products.optJSONObject(i);
            View child = productList.getChildAt(i);
            if (product == null || child == null || !(child.getTag() instanceof ProductCardHolder)) continue;
            bindProductCard((ProductCardHolder) child.getTag(), product);
        }
    }

    private ProductCardHolder createProductCard() {
        ProductCardHolder holder = new ProductCardHolder();
        holder.card = Ui.surface(this);
        holder.card.setPadding(dp(16), dp(14), dp(16), dp(6));

        LinearLayout titleRow = new LinearLayout(this);
        titleRow.setGravity(Gravity.TOP);
        holder.card.addView(titleRow, matchWrap());

        holder.name = Ui.text(this, "", R.dimen.restock_text_card_title, TEXT, Typeface.BOLD);
        holder.name.setMaxLines(2);
        holder.name.setEllipsize(TextUtils.TruncateAt.END);
        holder.name.setLineSpacing(0f, 1.15f);
        titleRow.addView(holder.name, new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            1f
        ));

        holder.menu = new ImageView(this);
        holder.menu.setImageResource(R.drawable.ic_overflow);
        holder.menu.setColorFilter(SUB);
        holder.menu.setContentDescription("상품 메뉴");
        holder.menu.setScaleType(ImageView.ScaleType.FIT_CENTER);
        holder.menu.setPadding(dp(14), dp(14), dp(14), dp(14));
        LinearLayout.LayoutParams menuLp = Ui.fixed(
            Ui.dim(this, R.dimen.restock_touch_min),
            Ui.dim(this, R.dimen.restock_touch_min)
        );
        menuLp.leftMargin = dp(4);
        menuLp.topMargin = -dp(10);
        titleRow.addView(holder.menu, menuLp);

        LinearLayout statusRow = new LinearLayout(this);
        statusRow.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams statusLp = matchWrap();
        statusLp.topMargin = dp(2);
        holder.card.addView(statusRow, statusLp);

        holder.badgeBox = new LinearLayout(this);
        holder.badgeBox.setOrientation(LinearLayout.HORIZONTAL);
        holder.badgeBox.setGravity(Gravity.CENTER_VERTICAL);
        holder.badgeBox.setPadding(dp(9), 0, dp(10), 0);
        statusRow.addView(holder.badgeBox, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            Ui.dim(this, R.dimen.restock_badge_height)
        ));

        holder.badgeDot = new View(this);
        LinearLayout.LayoutParams badgeDotLp = Ui.fixed(dp(6), dp(6));
        badgeDotLp.rightMargin = dp(5);
        holder.badgeBox.addView(holder.badgeDot, badgeDotLp);

        holder.badgeText = Ui.text(this, "", R.dimen.restock_text_caption, GREEN, Typeface.BOLD);
        holder.badgeBox.addView(holder.badgeText);

        holder.state = Ui.text(this, "", R.dimen.restock_text_label, SUB, Typeface.NORMAL);
        holder.state.setSingleLine(true);
        holder.state.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams stateLp = new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            1f
        );
        stateLp.leftMargin = dp(8);
        statusRow.addView(holder.state, stateLp);

        holder.toggle = new RestockSwitch(this);
        statusRow.addView(holder.toggle, Ui.fixed(
            Ui.dim(this, R.dimen.restock_switch_width),
            Ui.dim(this, R.dimen.restock_switch_height)
        ));

        LinearLayout.LayoutParams dividerLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            Math.max(1, dp(1))
        );
        dividerLp.topMargin = dp(6);
        holder.card.addView(Ui.hairline(this, LINE), dividerLp);

        holder.optionsRow = new LinearLayout(this);
        holder.optionsRow.setGravity(Gravity.CENTER_VERTICAL);
        holder.optionsRow.setMinimumHeight(Ui.dim(this, R.dimen.restock_touch_min));
        holder.card.addView(holder.optionsRow, matchWrap());

        holder.options = Ui.text(this, "", R.dimen.restock_text_label, SUB, Typeface.NORMAL);
        holder.options.setSingleLine(true);
        holder.options.setEllipsize(TextUtils.TruncateAt.END);
        holder.optionsRow.addView(holder.options, new LinearLayout.LayoutParams(
            0,
            LinearLayout.LayoutParams.WRAP_CONTENT,
            1f
        ));

        ImageView chevron = new ImageView(this);
        chevron.setImageResource(R.drawable.ic_chevron_right);
        chevron.setColorFilter(SUB);
        chevron.setScaleType(ImageView.ScaleType.FIT_CENTER);
        LinearLayout.LayoutParams chevronLp = Ui.fixed(dp(20), dp(20));
        chevronLp.leftMargin = dp(8);
        holder.optionsRow.addView(chevron, chevronLp);

        return holder;
    }

    private void bindProductCard(ProductCardHolder holder, JSONObject product) {
        holder.name.setText(product.optString("title", "SmartStore 상품"));
        bindStateBadge(holder, product);

        String summary = optionSummaryText(product);
        holder.options.setText(summary);
        holder.optionsRow.setContentDescription(summary + " · 옵션 수정");
        holder.optionsRow.setOnClickListener(v -> editProduct(product));

        holder.menu.setOnClickListener(v -> showCardMenu(v, product));
        holder.toggle.bind(product.optBoolean("enabled", false));
        holder.toggle.setListener(checked -> toggleProduct(product));
    }

    private void bindStateBadge(ProductCardHolder holder, JSONObject product) {
        int state = ProductStatus.stateOf(product);
        long lastCheck = product.optLong("lastCheck", 0L);
        long lastSuccess = product.optLong("lastSuccess", 0L);
        long now = System.currentTimeMillis();
        int available = ProductStatus.availableCount(product);
        int requested = ProductStatus.requestedCount(product);

        String label;
        int textColor;
        int background;
        String detail;
        boolean showDot = false;

        if (state == ProductStatus.FAILED) {
            label = "확인 실패";
            textColor = RED;
            background = RED_SOFT;
            detail = ProductStatus.failureReason(product);
            if (lastSuccess > 0L) detail += " · 마지막 정상 " + ProductStatus.clockTime(lastSuccess);
        } else if (state == ProductStatus.OUT_OF_STOCK) {
            label = "재고 없음";
            textColor = WARN;
            background = WARN_SOFT;
            detail = "0/" + requested
                + (lastCheck > 0L ? " · " + ProductStatus.relativeTime(lastCheck, now) : "");
        } else if (state == ProductStatus.PENDING) {
            label = "확인 중";
            textColor = SUB;
            background = FIELD;
            detail = "첫 확인을 기다리는 중";
        } else if (state == ProductStatus.OK) {
            label = "정상";
            textColor = GREEN;
            background = GREEN_SOFT;
            showDot = true;
            detail = "재고 있음 " + available + "/" + requested;
            if ("OUTOFSTOCK".equals(product.optString("lastProductStatus", ""))) {
                detail += " · 구매 불가";
            }
            if (lastCheck > 0L) detail += " · " + ProductStatus.relativeTime(lastCheck, now);
        } else {
            label = "알림 꺼짐";
            textColor = SUB;
            background = FIELD;
            detail = lastCheck > 0L
                ? "마지막 확인 " + ProductStatus.relativeTime(lastCheck, now)
                : "알림이 꺼져 있어요";
        }

        holder.badgeText.setText(label);
        holder.badgeText.setTextColor(textColor);
        holder.badgeBox.setBackground(Ui.roundRect(this, background, 12));
        holder.badgeDot.setVisibility(showDot ? View.VISIBLE : View.GONE);
        holder.badgeDot.setBackground(Ui.roundRect(this, textColor, 3));
        holder.state.setText(detail);
    }

    private String optionSummaryText(JSONObject product) {
        int count = ProductStatus.requestedCount(product);
        if (count == 0) return "선택 옵션 없음";
        String first = "";
        for (String label : labelMap(product.optJSONObject("selectedLabels")).values()) {
            first = cleanOptionLabel(label);
            if (!first.isBlank()) break;
        }
        String head = count + "개 옵션 감시 중";
        return first.isBlank() ? head : head + " · " + first;
    }

    private void showCardMenu(View anchor, JSONObject product) {
        PopupMenu menu = new PopupMenu(this, anchor);
        menu.getMenu().add(0, 1, 0, "옵션 수정");
        menu.getMenu().add(0, 2, 1, "삭제");
        menu.setOnMenuItemClickListener(item -> {
            if (item.getItemId() == 1) {
                editProduct(product);
                return true;
            }
            confirmDelete(product);
            return true;
        });
        menu.show();
    }

    private void toggleProduct(JSONObject product) {
        String id = product.optString("id", "");
        if (id.isBlank()) return;
        JSONObject current = ProductStore.find(this, id);
        if (current == null) current = product;
        boolean enable = !current.optBoolean("enabled", false);

        String siteType = current.optString(
            "siteType",
            SiteSupport.detect(current.optString("url", ""))
        );
        if (enable && SiteSupport.NAVER_SMARTSTORE.equals(siteType) && !hasNaverSession()) {
            pendingEnableProductId = id;
            launchLogin(current.optString("url", SMARTSTORE_HOME));
            return;
        }

        ProductStore.setEnabled(this, id, enable);
        syncMonitorService();
        // 순서와 스크롤을 유지한 채 그 자리에서만 다시 그린다.
        renderProducts(false);
    }

    private void enableAllProducts() {
        if (!NotificationAccess.isAllowed(this)) {
            toast("알림 권한을 먼저 허용해주세요. 설정에서 확인할 수 있어요.");
            return;
        }
        JSONArray products = ProductStore.list(this);
        String loginTarget = null;
        for (int i = 0; i < products.length(); i++) {
            JSONObject product = products.optJSONObject(i);
            if (product == null) continue;
            String siteType = product.optString(
                "siteType",
                SiteSupport.detect(product.optString("url", ""))
            );
            if (SiteSupport.NAVER_SMARTSTORE.equals(siteType)) {
                loginTarget = product.optString("url", SMARTSTORE_HOME);
                break;
            }
        }
        if (loginTarget != null && !hasNaverSession()) {
            pendingEnableAll = true;
            launchLogin(loginTarget);
            return;
        }
        applyEnableAll();
    }

    private void applyEnableAll() {
        pendingEnableAll = false;
        JSONArray products = ProductStore.list(this);
        for (int i = 0; i < products.length(); i++) {
            JSONObject product = products.optJSONObject(i);
            if (product == null) continue;
            ProductStore.setEnabled(this, product.optString("id", ""), true);
        }
        syncMonitorService();
        renderProducts(false);
        toast("모든 상품의 알림을 켰어요.");
    }

    private void disableAllProducts() {
        ProductStore.disableAll(this);
        syncMonitorService();
        renderProducts(false);
        toast("모든 상품의 알림을 껐어요.");
    }

    private void syncMonitorService() {
        int enabled = ProductStore.enabledCount(this);
        if (enabled <= 0) {
            startService(new Intent(this, MonitorService.class).setAction(MonitorService.ACTION_STOP));
            MonitorPrefs.setRunning(this, false);
            return;
        }
        startForegroundService(new Intent(this, MonitorService.class));
    }

    private void confirmDelete(JSONObject product) {
        new AlertDialog.Builder(this)
            .setTitle("삭제할까요?")
            .setNegativeButton("취소", null)
            .setPositiveButton("삭제", (d, w) -> {
                ProductStore.remove(this, product.optString("id"));
                syncMonitorService();
                renderProducts(true);
            })
            .show();
    }

    private void openLoginForExistingProduct() {
        JSONArray products = ProductStore.list(this);
        String target = SMARTSTORE_HOME;
        for (int i = 0; i < products.length(); i++) {
            JSONObject product = products.optJSONObject(i);
            if (product == null) continue;
            String url = product.optString("url", "");
            if (SiteSupport.NAVER_SMARTSTORE.equals(SiteSupport.detect(url))) {
                target = url;
                break;
            }
        }
        launchLogin(target);
    }

    private void launchLogin(String targetUrl) {
        if (loginLaunching) return;
        if (targetUrl == null || targetUrl.isBlank()
            || !SiteSupport.NAVER_SMARTSTORE.equals(SiteSupport.detect(targetUrl))) {
            targetUrl = SMARTSTORE_HOME;
        }
        loginLaunching = true;
        Intent intent = new Intent(this, LoginActivity.class);
        intent.putExtra(LoginActivity.EXTRA_TARGET_URL, targetUrl);
        Motion.pushForResult(this, intent, REQUEST_LOGIN);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_LOGIN) return;
        loginLaunching = false;
        refreshSessionButton();

        if (resultCode != RESULT_OK) {
            pendingEnableProductId = null;
            pendingEnableAll = false;
            if (optionLoadInProgress) {
                optionLoadInProgress = false;
                resumeMonitorAfterOptionLookup();
                clearPendingEdit();
            }
            return;
        }

        if (pendingEnableAll) {
            applyEnableAll();
        } else if (pendingEnableProductId != null) {
            ProductStore.setEnabled(this, pendingEnableProductId, true);
            pendingEnableProductId = null;
            syncMonitorService();
            renderProducts(false);
        }

        if (!pendingUrl.isBlank() && optionLoadInProgress) {
            CookieManager.getInstance().flush();
            directLookupAttempt = false;
            webView.stopLoading();
            webView.clearCache(true);
            webView.clearHistory();
            webView.loadUrl("about:blank");
            handler.postDelayed(() -> {
                if (pendingUrl.isBlank() || !optionLoadInProgress) return;
                autoInspect = true;
                webView.onResume();
                webView.resumeTimers();
                webView.loadUrl(pendingUrl);
            }, 700L);
        }
    }

    private void clearAppLogin() {
        SessionState.clearForLogout(this);
        CookieManager cookies = CookieManager.getInstance();
        cookies.removeAllCookies(value -> {
            cookies.flush();
            WebStorage.getInstance().deleteAllData();
            if (webView != null) {
                webView.clearCache(true);
                webView.clearHistory();
                webView.loadUrl("about:blank");
            }
            runOnUiThread(() -> {
                Intent intent = new Intent(this, GateActivity.class);
                intent.addFlags(
                    Intent.FLAG_ACTIVITY_CLEAR_TOP
                        | Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_CLEAR_TASK
                );
                startActivity(intent);
                finish();
            });
        });
    }

    private boolean isRunning() {
        return MonitorPrefs.prefs(this).getBoolean(MonitorPrefs.KEY_RUNNING, false);
    }

    private Map<String, String> labelMap(JSONObject object) {
        Map<String, String> result = new LinkedHashMap<>();
        if (object == null) return result;
        var keys = object.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            result.put(key, object.optString(key, key));
        }
        return result;
    }

    // SmartStore 옵션 그룹에는 구매 동의·필수 표시가 옵션명처럼 섞여 들어온다.
    private static final String[] OPTION_NOISE = {
        "동의합니다.", "동의합니다", "[필수]", "필수", "선택", "옵션 선택", "옵션"
    };

    static String optionLabel(JSONObject option) {
        if (option == null) return "옵션";
        Set<String> seen = new HashSet<>();
        StringBuilder label = new StringBuilder();
        for (String key : new String[]{"optionName1", "optionName2", "optionName3"}) {
            String value = cleanOptionToken(option.optString(key, ""));
            if (value.isBlank() || !seen.add(value)) continue;
            if (label.length() > 0) label.append(" / ");
            label.append(value);
        }
        return label.length() == 0 ? option.optString("id", "옵션") : label.toString();
    }

    /** 저장된 옵션 라벨("A / B / C")에서 상용구를 걸러 낸다. */
    static String cleanOptionLabel(String label) {
        if (label == null) return "";
        StringBuilder out = new StringBuilder();
        for (String part : label.split(" / ")) {
            String token = cleanOptionToken(part);
            if (token.isBlank()) continue;
            if (out.length() > 0) out.append(" / ");
            out.append(token);
        }
        return out.toString();
    }

    private static String cleanOptionToken(String value) {
        if (value == null) return "";
        String token = value.trim();
        if (token.isBlank() || "null".equals(token)) return "";
        for (String noise : OPTION_NOISE) {
            if (noise.equalsIgnoreCase(token)) return "";
        }
        return token;
    }

    @SuppressLint("SetJavaScriptEnabled")
    static void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setLoadsImagesAutomatically(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) settings.setSafeBrowsingEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString()
            .replace("; wv)", ")")
            .replace("Version/4.0 ", ""));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);
    }

    private boolean blockUntrustedNavigation(String url) {
        if (pendingUrl == null || pendingUrl.isBlank() || url == null || url.isBlank()) return false;
        String siteType = SiteSupport.detect(pendingUrl);
        if (SiteSupport.NAVER_SMARTSTORE.equals(siteType) && SiteSupport.isNaverLoginUrl(url)) return false;
        if (SiteSupport.isAllowedPage(siteType, url)) return false;
        JSONObject product = ProductStore.find(this, editingProductId == null
            ? ProductStore.idFromUrl(pendingUrl)
            : editingProductId);
        DiagnosticLog.add(this, "BLOCKED_NAV", product, safeHost(url));
        toast("허용되지 않은 사이트 이동을 차단했어요.");
        return true;
    }

    private String safeHost(String url) {
        try {
            String host = Uri.parse(url).getHost();
            return host == null ? "unknown" : host;
        } catch (Exception ignored) {
            return "unknown";
        }
    }

    private void sizeDialog(Dialog dialog, float widthRatio) {
        Window window = dialog.getWindow();
        if (window == null) return;
        window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        WindowManager.LayoutParams lp = window.getAttributes();
        lp.width = (int) (getResources().getDisplayMetrics().widthPixels * widthRatio);
        lp.height = WindowManager.LayoutParams.WRAP_CONTENT;
        lp.dimAmount = 0.32f;
        window.setAttributes(lp);
        window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void toast(String value) {
        Toast.makeText(this, value, Toast.LENGTH_SHORT).show();
    }

    private TextView text(String value, float size, int color, int style) {
        return Ui.textSp(this, value, size, color, style);
    }

    private LinearLayout surface(int radius, int padding) {
        return Ui.surface(this, radius, padding);
    }

    private GradientDrawable roundRect(int color, int radius) {
        return Ui.roundRect(this, color, radius);
    }

    private LinearLayout.LayoutParams matchWrap() {
        return Ui.matchWrap();
    }

    private LinearLayout.LayoutParams sectionParams() {
        LinearLayout.LayoutParams params = Ui.matchWrap();
        params.bottomMargin = Ui.dim(this, R.dimen.restock_card_gap);
        return params;
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 7001);
        }
    }

    private void resumeMonitorIfNeeded() {
        if (ProductStore.enabledCount(this) > 0
            && NotificationAccess.isAllowed(this)) {
            // Always ask the service to ensure monitoring is alive. MonitorService
            // de-duplicates repeated starts within the same process, while a stale
            // persisted running flag cannot block recovery after process death/update.
            startForegroundService(new Intent(this, MonitorService.class));
        }
    }

    @Override protected void onResume() {
        super.onResume();
        if (redirectToGateIfNeeded()) return;
        handler.removeCallbacks(statusRefresh);
        handler.removeCallbacks(resumeRefresh);

        refreshProductsOnResume = !firstResume;
        long delay = firstResume ? 320L : 300L;
        firstResume = false;
        handler.postDelayed(resumeRefresh, delay);
    }

    @Override protected void onPause() {
        handler.removeCallbacks(resumeRefresh);
        handler.removeCallbacks(statusRefresh);
        super.onPause();
    }

    @Override protected void onDestroy() {
        resumeMonitorAfterOptionLookup();
        handler.removeCallbacksAndMessages(null);
        if (optionDialog != null && optionDialog.isShowing()) optionDialog.dismiss();
        if (addDialog != null && addDialog.isShowing()) addDialog.dismiss();
        if (webView != null) {
            webView.removeJavascriptInterface("RestockBridge");
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }
}
