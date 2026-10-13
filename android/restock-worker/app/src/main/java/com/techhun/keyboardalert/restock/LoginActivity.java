package com.techhun.keyboardalert.restock;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

public class LoginActivity extends Activity {
    static final String EXTRA_TARGET_URL = "target_url";
    private static final String NAVER_APP_PACKAGE = "com.nhn.android.search";

    private WebView webView;
    private String targetUrl;
    private boolean completing;
    private boolean externalLoginLaunched;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        targetUrl = getIntent().getStringExtra(EXTRA_TARGET_URL);
        if (targetUrl == null || targetUrl.isBlank()) targetUrl = SessionState.SMARTSTORE_HOME;

        Window window = getWindow();
        window.setStatusBarColor(Color.WHITE);
        window.setNavigationBarColor(Color.WHITE);
        window.getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        );

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);
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
            view.setPadding(0, top, 0, bottom);
            return insets;
        });

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(16), 0, dp(16), 0);
        root.addView(header, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(46)
        ));

        TextView close = new TextView(this);
        close.setText("닫기");
        close.setTextSize(15f);
        close.setTextColor(Color.rgb(49, 130, 246));
        close.setGravity(Gravity.CENTER_VERTICAL);
        close.setOnClickListener(v -> finish());
        Motion.press(close);
        header.addView(close, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.MATCH_PARENT
        ));

        webView = new WebView(this);
        MainActivity.configureWebView(webView);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleNavigation(view, request.getUrl().toString());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleNavigation(view, url);
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (loginCompleted(url)) {
                    view.stopLoading();
                    completeLogin();
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (loginCompleted(url)) completeLogin();
            }
        });
        root.addView(webView, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            0,
            1f
        ));

        setContentView(root);
        root.requestApplyInsets();
        Motion.enter(header, 0L);

        String loginUrl = "https://nid.naver.com/nidlogin.login?url=" + Uri.encode(targetUrl);
        webView.loadUrl(loginUrl);
    }

    private boolean handleNavigation(WebView view, String url) {
        if (url == null || url.isBlank()) return false;
        if (loginCompleted(url)) {
            completeLogin();
            return true;
        }

        Uri uri;
        try {
            uri = Uri.parse(url);
        } catch (Exception ignored) {
            return false;
        }

        String scheme = uri.getScheme();
        if (scheme == null
            || "http".equalsIgnoreCase(scheme)
            || "https".equalsIgnoreCase(scheme)) {
            return false;
        }

        if ("nidlogin".equalsIgnoreCase(scheme)) {
            launchNaverApp(new Intent(Intent.ACTION_VIEW, uri));
            return true;
        }

        if ("intent".equalsIgnoreCase(scheme)) {
            try {
                Intent intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
                String packageName = intent.getPackage();
                if (packageName == null || packageName.isBlank() || NAVER_APP_PACKAGE.equals(packageName)) {
                    intent.setPackage(NAVER_APP_PACKAGE);
                    if (launchNaverApp(intent)) return true;
                }
                String fallback = intent.getStringExtra("browser_fallback_url");
                if (isSafeWebFallback(fallback)) view.loadUrl(fallback);
            } catch (Exception ignored) {}
            return true;
        }

        // Login WebView should never hand arbitrary custom schemes to other apps.
        return true;
    }

    private boolean launchNaverApp(Intent intent) {
        try {
            intent.setPackage(NAVER_APP_PACKAGE);
            if (intent.resolveActivity(getPackageManager()) == null) {
                showNaverAppFallback();
                return false;
            }
            externalLoginLaunched = true;
            startActivity(intent);
            return true;
        } catch (ActivityNotFoundException missing) {
            showNaverAppFallback();
            return false;
        } catch (Exception ignored) {
            showNaverAppFallback();
            return false;
        }
    }

    private void showNaverAppFallback() {
        Toast.makeText(
            this,
            "네이버 앱을 찾을 수 없어요. 아래에서 직접 로그인해주세요.",
            Toast.LENGTH_SHORT
        ).show();
    }

    private boolean isSafeWebFallback(String value) {
        if (value == null || value.isBlank()) return false;
        try {
            Uri uri = Uri.parse(value);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (!"https".equalsIgnoreCase(scheme) || host == null) return false;
            return host.equals("naver.com") || host.endsWith(".naver.com");
        } catch (Exception ignored) {
            return false;
        }
    }

    private void completeLogin() {
        if (completing || !SessionState.hasNaverSession()) return;
        completing = true;
        SessionState.markNaverAuthenticated(this);
        CookieManager.getInstance().flush();
        Intent result = new Intent();
        result.putExtra(EXTRA_TARGET_URL, targetUrl);
        setResult(RESULT_OK, result);
        finish();
    }

    private boolean loginCompleted(String url) {
        if (url == null || url.isBlank()) return false;
        try {
            Uri uri = Uri.parse(url);
            String scheme = uri.getScheme();
            if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return false;
            String host = uri.getHost();
            if (host == null) return false;
            boolean smartStoreHost = host.equals("smartstore.naver.com") || host.endsWith(".smartstore.naver.com");
            if (!smartStoreHost || !SessionState.hasNaverSession()) return false;
            if (isProductTarget()) return isProductUrl(uri);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean isProductTarget() {
        try {
            Uri uri = Uri.parse(targetUrl);
            String path = uri.getPath();
            return path != null && path.contains("/products/");
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean isProductUrl(Uri uri) {
        String path = uri.getPath();
        return path != null && path.contains("/products/");
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
            webView.resumeTimers();
            if (externalLoginLaunched) {
                externalLoginLaunched = false;
                webView.requestFocus();
            }
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    public void finish() {
        super.finish();
        Motion.pop(this);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
