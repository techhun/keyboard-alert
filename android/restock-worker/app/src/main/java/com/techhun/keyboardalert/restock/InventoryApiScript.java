package com.techhun.keyboardalert.restock;

import org.json.JSONObject;

import java.util.Locale;

final class InventoryApiScript {
    private InventoryApiScript() {}

    static String build(JSONObject product) {
        String productId = JSONObject.quote(product == null ? "" : product.optString("id", ""));
        String apiUrl = JSONObject.quote(product == null ? "" : product.optString("apiUrl", ""));
        String fallbackTitle = JSONObject.quote(product == null ? "SmartStore 상품" : product.optString("title", "SmartStore 상품"));
        return String.format(Locale.ROOT, """
            (() => {
              const send = (value) => window.RestockBridge.onResult(JSON.stringify(value));
              (async () => {
                const productId = %s;
                const configuredApiUrl = %s;
                const fallbackTitle = %s;

                function normalizeApiUrl(value) {
                  if (!value) return null;
                  try {
                    const parsed = new URL(value, location.href);
                    const host = parsed.hostname.toLowerCase();
                    if (host !== 'smartstore.naver.com' && !host.endsWith('.smartstore.naver.com')) return null;
                    return location.origin + parsed.pathname + parsed.search;
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
                  const apiUrl = normalizeApiUrl(configuredApiUrl);
                  if (!apiUrl) {
                    send({ ok: false, error: 'API_URL_MISSING', productId });
                    return;
                  }
                  const parsedApi = new URL(apiUrl, location.href);
                  const apiProductMatch = parsedApi.pathname.match(/^.*?\\/products\\/(\\d+)(?:\\/|$)/);
                  if (!apiProductMatch || apiProductMatch[1] !== productId) {
                    send({ ok: false, error: 'API_PRODUCT_MISMATCH', productId, apiUrl });
                    return;
                  }

                  const response = await fetch(apiUrl, {
                    credentials: 'include',
                    headers: { accept: 'application/json, text/plain, */*' }
                  });
                  const text = await response.text();

                  if (isAuthResponse(response, text)) {
                    send({ ok: false, error: 'AUTH_REQUIRED', productId, status: response.status, apiUrl });
                    return;
                  }

                  if (response.status === 204) {
                    send({ ok: false, error: 'NO_CONTENT', productId, status: response.status, apiUrl });
                    return;
                  }
                  if (response.status === 429) {
                    send({ ok: false, error: 'RATE_LIMITED', productId, status: response.status, apiUrl });
                    return;
                  }

                  let data = null;
                  try { data = JSON.parse(text); } catch (ignored) {}
                  if (!response.ok || !data) {
                    send({
                      ok: false,
                      error: response.ok ? 'PRODUCT_DATA_NOT_FOUND' : 'PRODUCT_API_FAILED',
                      productId,
                      status: response.status,
                      apiUrl
                    });
                    return;
                  }

                  const originProduct = data.originProduct && typeof data.originProduct === 'object'
                    ? data.originProduct
                    : data;
                  const optionInfo = originProduct?.detailAttribute?.optionInfo
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
                    const stock = Number(originProduct?.stockQuantity ?? data?.stockQuantity);
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
                    productId,
                    apiUrl,
                    title: originProduct?.name || data?.smartstoreChannelProduct?.channelProductName || fallbackTitle,
                    stockQuantity: originProduct?.stockQuantity ?? data?.stockQuantity ?? null,
                    options
                  });
                } catch (error) {
                  send({ ok: false, error: 'JS_ERROR', productId, message: String(error) });
                }
              })();
              return 'STARTED';
            })()
            """, productId, apiUrl, fallbackTitle);
    }
}
