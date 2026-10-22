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
          window.__RESTOCK_PRODUCT_OUTCOMES__ = [];
          const trace = window.__RESTOCK_CAPTURE_TRACE__ = { installedAt: Math.round(performance.now()), requests: [] };

          const smartStoreUrl = (value) => {
            try {
              const parsed = new URL(String(value || ''), location.href);
              const host = parsed.hostname.toLowerCase();
              return host === 'smartstore.naver.com' || host.endsWith('.smartstore.naver.com');
            } catch (ignored) {
              return false;
            }
          };

          const isExactProductApi = (url) => {
            try {
              const parsed = new URL(String(url || ''), location.href);
              return /^\\/i\\/v2\\/channels\\/[^/]+\\/products\\/\\d+\\/?$/.test(parsed.pathname);
            } catch (ignored) {
              return false;
            }
          };

          const startRequest = (url, transport) => {
            try {
              if (!smartStoreUrl(url) || !isExactProductApi(url)) return null;
              const productNo = new URL(String(url), location.href).pathname.split('/').filter(Boolean).pop();
              const request = { productNo, transport, start: Math.round(performance.now()), done: false };
              trace.requests.push(request);
              while (trace.requests.length > 12) trace.requests.shift();
              return request;
            } catch (ignored) { return null; }
          };
          const finishRequest = (request) => {
            if (!request) return;
            request.done = true;
            request.end = Math.round(performance.now());
          };

          // Status-only telemetry: do not retain headers, cookies, or error bodies.
          const recordOutcome = (url, status, kind) => {
            try {
              if (!smartStoreUrl(url) || !isExactProductApi(url)) return;
              const productNo = new URL(String(url), location.href).pathname.split('/').filter(Boolean).pop();
              const list = window.__RESTOCK_PRODUCT_OUTCOMES__;
              list.push({ productNo, status: Number(status || 0), kind, age: Math.round(performance.now()) });
              while (list.length > 12) list.shift();
            } catch (ignored) {}
          };

          const looksRelevant = (url, data) => {
            if (!smartStoreUrl(url) || !data || typeof data !== 'object') return false;
            const text = JSON.stringify(data);
            if (text.length > 2000000) return false;
            if (isExactProductApi(url)) return true;
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
              window.fetch = trace.fetchHook = async function(...args) {
                const request = startRequest(args[0]?.url || args[0], 'fetch');
                let response;
                try {
                  response = await originalFetch.apply(this, args);
                } catch (error) {
                  finishRequest(request);
                  recordOutcome(args[0]?.url || args[0], 0, 'network-error');
                  throw error;
                }
                finishRequest(request);
                recordOutcome(response.url, response.status, 'http');
                try {
                  const clone = response.clone();
                  clone.json().then((data) => record(response.url, response.status, data))
                    .catch(() => recordOutcome(response.url, response.status, 'not-json'));
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
            XMLHttpRequest.prototype.send = trace.xhrHook = function(...args) {
              const request = startRequest(this.__restockUrl, 'xhr');
              this.addEventListener('loadend', () => finishRequest(request), { once: true });
              this.addEventListener('load', function() {
                recordOutcome(this.responseURL || this.__restockUrl, this.status, 'http');
                try {
                  let data = null;
                  if (this.responseType === 'json') data = this.response;
                  else if (!this.responseType || this.responseType === 'text') data = JSON.parse(this.responseText);
                  record(this.responseURL || this.__restockUrl, this.status, data);
                } catch (ignored) {
                  recordOutcome(this.responseURL || this.__restockUrl, this.status, 'not-json');
                }
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
