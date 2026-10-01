package com.techhun.keyboardalert.restock;

import org.json.JSONObject;

import java.util.Locale;

final class InventoryScript {
    private InventoryScript() {}

    static final String SCRIPT = build(null);

    static String build(JSONObject seedProduct) {
        String configuredApiUrl = JSONObject.quote(seedProduct == null ? "" : seedProduct.optString("apiUrl", ""));
        String configuredChannelUid = JSONObject.quote(seedProduct == null ? "" : seedProduct.optString("channelUid", ""));
        String configuredProductNo = JSONObject.quote(seedProduct == null ? "" : seedProduct.optString("productNo", ""));
        return String.format(Locale.ROOT, """
        (() => {
          const send = (value) => window.RestockBridge.onResult(JSON.stringify(value));
          (async () => {
            const configuredApiUrl = %s;
            const configuredChannelUid = %s;
            const configuredProductNo = %s;

            function safeNaverApiUrl(value) {
              if (!value) return null;
              try {
                const parsed = new URL(value, location.href);
                const host = parsed.hostname.toLowerCase();
                if (host !== 'smartstore.naver.com' && !host.endsWith('.smartstore.naver.com')) return null;
                return parsed.toString();
              } catch (ignored) {
                return null;
              }
            }

            function isAuthResponse(response, text) {
              if (!response) return false;
              if (response.status === 401 || response.status === 403) return true;
              try {
                const finalUrl = new URL(response.url || location.href, location.href);
                const host = finalUrl.hostname.toLowerCase();
                if (host === 'nid.naver.com' || finalUrl.pathname.includes('nidlogin.login')) return true;
              } catch (ignored) {}
              const contentType = (response.headers.get('content-type') || '').toLowerCase();
              if (!contentType.includes('text/html')) return false;
              const preview = String(text || '').slice(0, 1500).toLowerCase();
              return preview.includes('nidlogin') || preview.includes('naver 로그인');
            }

            try {
              const productMatch = location.pathname.match(/\\/products\\/(\\d+)/);
              const productNo = productMatch ? productMatch[1] : (configuredProductNo || null);
              if (!productNo) {
                send({ ok: false, error: 'PRODUCT_NO_NOT_FOUND', pageUrl: location.href, title: document.title });
                return;
              }

              function findChannelUid(root) {
                if (!root || typeof root !== 'object') return null;
                const stack = [root];
                const seen = new Set();
                let count = 0;
                while (stack.length && count < 30000) {
                  const value = stack.pop();
                  if (!value || typeof value !== 'object' || seen.has(value)) continue;
                  seen.add(value);
                  count += 1;
                  if (typeof value.channelUid === 'string' && value.channelUid.length >= 8) return value.channelUid;
                  for (const child of Object.values(value)) {
                    if (child && typeof child === 'object') stack.push(child);
                  }
                }
                return null;
              }

              function findChannelUidInHtml() {
                const html = document.documentElement?.innerHTML || '';
                const matches = html.matchAll(/channelUid[^A-Za-z0-9_-]{0,40}([A-Za-z0-9_-]{8,80})/g);
                for (const match of matches) {
                  const value = match[1];
                  if (!value || value === 'broadcastAuthority' || value === 'undefined') continue;
                  return value;
                }
                return null;
              }

              function looksLikeProductPayload(data) {
                if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
                const product = data.originProduct && typeof data.originProduct === 'object' ? data.originProduct : data;
                const id = String(product?.id ?? data?.id ?? '');
                if (id && id === productNo) return true;
                return !!(
                  product?.detailAttribute?.optionInfo
                  || data?.detailAttribute?.optionInfo
                  || data?.optionInfo
                  || Array.isArray(data?.optionCombinations)
                  || product?.stockQuantity !== undefined
                  || data?.stockQuantity !== undefined
                );
              }

              let channelUid = configuredChannelUid || null;
              let observedApiUrl = safeNaverApiUrl(configuredApiUrl);
              const roots = [window.__PRELOADED_STATE__, window.__INITIAL_STATE__, window.__NEXT_DATA__].filter(Boolean);
              if (!channelUid) {
                for (const root of roots) {
                  channelUid = findChannelUid(root);
                  if (channelUid) break;
                }
              }
              if (!channelUid) channelUid = findChannelUidInHtml();

              const resources = performance.getEntriesByType('resource').map((entry) => entry.name || '');
              for (const resourceUrl of resources) {
                try {
                  const parsed = new URL(resourceUrl, location.href);
                  const anyProductMatch = parsed.pathname.match(/^\\/i\\/v2\\/channels\\/([^/]+)\\/products\\/(\\d+)(?:\\/.*)?$/);
                  if (!anyProductMatch) continue;
                  if (!channelUid) channelUid = decodeURIComponent(anyProductMatch[1]);

                  const exactProductMatch = parsed.pathname.match(/^\\/i\\/v2\\/channels\\/([^/]+)\\/products\\/(\\d+)\\/?$/);
                  if (exactProductMatch && exactProductMatch[2] === productNo) {
                    observedApiUrl = parsed.toString();
                  }
                } catch (ignored) {}
              }

              const candidates = [];
              if (observedApiUrl) candidates.push(observedApiUrl);
              if (channelUid) {
                const encodedUid = encodeURIComponent(channelUid);
                candidates.push(`${location.origin}/i/v2/channels/${encodedUid}/products/${productNo}?withWindow=false`);
                candidates.push(`https://smartstore.naver.com/i/v2/channels/${encodedUid}/products/${productNo}?withWindow=false`);
                candidates.push(`https://m.smartstore.naver.com/i/v2/channels/${encodedUid}/products/${productNo}?withWindow=false`);
              }

              if (!candidates.length) {
                send({ ok: false, error: 'CHANNEL_UID_NOT_FOUND', pageUrl: location.href, title: document.title });
                return;
              }

              let response = null;
              let text = '';
              let data = null;
              let usedApiUrl = null;
              const attempts = [];

              for (const apiUrl of [...new Set(candidates)]) {
                try {
                  const parsed = new URL(apiUrl, location.href);
                  const requestUrl = parsed.origin === location.origin
                    ? parsed.pathname + parsed.search
                    : apiUrl;
                  const current = await fetch(requestUrl, {
                    credentials: 'include',
                    headers: { accept: 'application/json, text/plain, */*' }
                  });
                  const currentText = await current.text();

                  if (isAuthResponse(current, currentText)) {
                    send({
                      ok: false,
                      error: 'AUTH_REQUIRED',
                      status: current.status,
                      pageUrl: location.href,
                      apiUrl,
                      attempts
                    });
                    return;
                  }

                  let currentData = null;
                  let validPayload = false;
                  if (current.ok) {
                    try {
                      currentData = JSON.parse(currentText);
                      validPayload = looksLikeProductPayload(currentData);
                    } catch (ignored) {}
                  }
                  attempts.push({ url: apiUrl, status: current.status, validPayload });

                  if (current.ok && validPayload) {
                    response = current;
                    text = currentText;
                    data = currentData;
                    usedApiUrl = apiUrl;
                    break;
                  }

                  if (!response) {
                    response = current;
                    text = currentText;
                    usedApiUrl = apiUrl;
                  }
                } catch (error) {
                  attempts.push({ url: apiUrl, error: String(error) });
                }
              }

              if (!data) {
                send({
                  ok: false,
                  error: response?.ok ? 'PRODUCT_DATA_NOT_FOUND' : 'PRODUCT_API_FAILED',
                  status: response ? response.status : null,
                  pageUrl: location.href,
                  apiUrl: usedApiUrl,
                  attempts
                });
                return;
              }

              const product = data.originProduct && typeof data.originProduct === 'object'
                ? data.originProduct
                : data;
              const optionInfo = product?.detailAttribute?.optionInfo
                || data?.detailAttribute?.optionInfo
                || data?.optionInfo
                || data;
              const combinations = Array.isArray(optionInfo?.optionCombinations)
                ? optionInfo.optionCombinations
                : [];

              const options = combinations.map((option) => {
                const stock = Number(option.stockQuantity);
                return {
                  id: String(option.id ?? ''),
                  optionName1: option.optionName1 ?? null,
                  optionName2: option.optionName2 ?? null,
                  optionName3: option.optionName3 ?? null,
                  stockQuantity: Number.isFinite(stock) ? stock : null,
                  available: option.usable !== false && Number.isFinite(stock) && stock > 0
                };
              });

              if (!options.length) {
                const stock = Number(product?.stockQuantity ?? data?.stockQuantity);
                options.push({
                  id: 'default',
                  optionName1: '기본 상품',
                  optionName2: null,
                  optionName3: null,
                  stockQuantity: Number.isFinite(stock) ? stock : null,
                  available: Number.isFinite(stock) && stock > 0
                });
              }

              send({
                ok: true,
                pageUrl: location.href,
                apiUrl: usedApiUrl,
                title: product?.name || data?.smartstoreChannelProduct?.channelProductName || document.title,
                channelUid: channelUid || '',
                id: product?.id ?? data?.id ?? null,
                productNo: data?.productNo ?? productNo,
                statusType: product?.statusType || data?.statusType || data?.productStatusType || null,
                stockQuantity: product?.stockQuantity ?? data?.stockQuantity ?? null,
                optionCombinationCount: options.length,
                options,
                attempts
              });
            } catch (error) {
              send({ ok: false, error: 'JS_ERROR', message: String(error && (error.stack || error.message) || error) });
            }
          })();
          return 'STARTED';
        })()
        """, configuredApiUrl, configuredChannelUid, configuredProductNo);
    }
}
