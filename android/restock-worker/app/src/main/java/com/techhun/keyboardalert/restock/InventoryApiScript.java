package com.techhun.keyboardalert.restock;

import org.json.JSONObject;

final class InventoryApiScript {
    private InventoryApiScript() {}

    static String build(JSONObject product) {
        String productId = JSONObject.quote(product.optString("id", ""));
        String apiUrl = JSONObject.quote(product.optString("apiUrl", ""));
        String fallbackTitle = JSONObject.quote(product.optString("title", "SmartStore 상품"));
        return """
            (() => {
              const send = (value) => window.RestockBridge.onResult(JSON.stringify(value));
              (async () => {
                const productId = %s;
                const configuredApiUrl = %s;
                const fallbackTitle = %s;
                try {
                  if (!configuredApiUrl) {
                    send({ ok: false, error: 'API_URL_MISSING', productId });
                    return;
                  }
                  const parsed = new URL(configuredApiUrl, location.href);
                  const apiUrl = location.origin + parsed.pathname + parsed.search;
                  const response = await fetch(apiUrl, {
                    credentials: 'include',
                    headers: { accept: 'application/json, text/plain, */*' }
                  });
                  const text = await response.text();
                  let data = null;
                  try { data = JSON.parse(text); } catch (ignored) {}
                  if (!response.ok || !data) {
                    send({
                      ok: false,
                      error: 'PRODUCT_API_FAILED',
                      productId,
                      status: response.status,
                      apiUrl,
                      preview: text.replace(/\s+/g, ' ').slice(0, 180)
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
            """.replaceFirst("%s", productId)\n                .replaceFirst("%s", apiUrl)\n                .replaceFirst("%s", fallbackTitle);
    }
}
