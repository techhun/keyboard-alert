package com.techhun.keyboardalert.restock;

import org.json.JSONObject;

final class InventoryScript {
    private InventoryScript() {}

    static String build(JSONObject product) {
        String channelUid = product == null ? "" : product.optString("channelUid", "");
        return SCRIPT.replace(
            "const configuredChannelUid = '';",
            "const configuredChannelUid = " + JSONObject.quote(channelUid) + ";"
        );
    }

    static final String SCRIPT = """
        (() => {
          const send = (value) => window.RestockBridge.onResult(JSON.stringify(value));
          (async () => {
            try {
              const productMatch = location.pathname.match(/\\/products\\/(\\d+)/);
              const productNo = productMatch ? productMatch[1] : null;
              const configuredChannelUid = '';
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
              let observedApiUrl = null;

              function inspectCurrentPage() {
                const roots = [window.__PRELOADED_STATE__, window.__INITIAL_STATE__, window.__NEXT_DATA__].filter(Boolean);
                if (!channelUid) {
                  for (const root of roots) {
                    channelUid = findChannelUid(root);
                    if (channelUid) break;
                  }
                }

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

                if (!channelUid) {
                  for (const script of [...document.scripts]) {
                    const scriptText = script.textContent || '';
                    if (!scriptText || !scriptText.includes('channelUid')) continue;
                    const match = scriptText.match(/["']channelUid["']\\s*:\\s*["']([^"']{8,})["']/);
                    if (match) {
                      channelUid = match[1];
                      break;
                    }
                  }
                }
              }

              for (let attempt = 0; attempt < 7 && !channelUid; attempt++) {
                inspectCurrentPage();
                if (!channelUid && attempt < 6) {
                  await new Promise((resolve) => setTimeout(resolve, 600));
                }
              }

              if (!channelUid) {
                send({ ok: false, error: 'CHANNEL_UID_NOT_FOUND', pageUrl: location.href, title: document.title });
                return;
              }

              const encodedUid = encodeURIComponent(channelUid);
              const candidates = [];
              if (observedApiUrl) candidates.push(observedApiUrl);
              candidates.push(`${location.origin}/i/v2/channels/${encodedUid}/products/${productNo}?withWindow=false`);
              candidates.push(`https://smartstore.naver.com/i/v2/channels/${encodedUid}/products/${productNo}?withWindow=false`);
              candidates.push(`https://m.smartstore.naver.com/i/v2/channels/${encodedUid}/products/${productNo}?withWindow=false`);

              let response = null;
              let text = '';
              let data = null;
              let usedApiUrl = null;
              const attempts = [];

              for (const apiUrl of [...new Set(candidates)]) {
                try {
                  const current = await fetch(apiUrl, {
                    credentials: 'include',
                    headers: { accept: 'application/json, text/plain, */*' }
                  });
                  const currentText = await current.text();
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
                  attempts,
                  preview: text.replace(/\\s+/g, ' ').slice(0, 300)
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
                const stock = option.stockQuantity == null ? NaN : Number(option.stockQuantity);
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
                const rawStock = product?.stockQuantity ?? data?.stockQuantity;
                const stock = rawStock == null ? NaN : Number(rawStock);
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
                channelUid,
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
        """;
}
