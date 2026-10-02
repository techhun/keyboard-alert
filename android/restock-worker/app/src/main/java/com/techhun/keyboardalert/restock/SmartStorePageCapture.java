package com.techhun.keyboardalert.restock;

import android.webkit.WebView;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.util.Collections;

final class SmartStorePageCapture {
    private SmartStorePageCapture() {}

    static final String SCRIPT = """
        (() => {
          if (window.__RESTOCK_CAPTURE_INSTALLED__) return;
          window.__RESTOCK_CAPTURE_INSTALLED__ = true;
          window.__RESTOCK_CAPTURED_RESPONSES__ = [];

          const smartStoreUrl = (value) => {
            try {
              const parsed = new URL(String(value || ''), location.href);
              const host = parsed.hostname.toLowerCase();
              return host === 'smartstore.naver.com' || host.endsWith('.smartstore.naver.com');
            } catch (ignored) {
              return false;
            }
          };

          const looksRelevant = (url, data) => {
            if (!smartStoreUrl(url) || !data || typeof data !== 'object') return false;
            const text = JSON.stringify(data);
            if (text.length > 2000000) return false;
            return text.includes('optionCombinations')
              || text.includes('optionSimple')
              || text.includes('optionInfo')
              || (text.includes('stockQuantity') && text.includes('product'));
          };

          const record = (url, status, data) => {
            try {
              if (!looksRelevant(url, data)) return;
              const list = window.__RESTOCK_CAPTURED_RESPONSES__;
              list.push({ url: String(url || ''), status: Number(status || 0), data });
              while (list.length > 12) list.shift();
            } catch (ignored) {}
          };

          try {
            const originalFetch = window.fetch;
            if (typeof originalFetch === 'function') {
              window.fetch = async function(...args) {
                const response = await originalFetch.apply(this, args);
                try {
                  const clone = response.clone();
                  clone.json().then((data) => record(response.url, response.status, data)).catch(() => {});
                } catch (ignored) {}
                return response;
              };
            }
          } catch (ignored) {}

          try {
            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function(method, url, ...rest) {
              this.__restockUrl = url;
              return originalOpen.call(this, method, url, ...rest);
            };
            XMLHttpRequest.prototype.send = function(...args) {
              this.addEventListener('load', function() {
                try {
                  let data = null;
                  if (this.responseType === 'json') data = this.response;
                  else if (!this.responseType || this.responseType === 'text') data = JSON.parse(this.responseText);
                  record(this.responseURL || this.__restockUrl, this.status, data);
                } catch (ignored) {}
              }, { once: true });
              return originalSend.apply(this, args);
            };
          } catch (ignored) {}
        })();
        """;

    static void install(WebView webView) {
        if (webView == null) return;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return;
        WebViewCompat.addDocumentStartJavaScript(
            webView,
            SCRIPT,
            Collections.singleton("https://*.smartstore.naver.com")
        );
    }
}
