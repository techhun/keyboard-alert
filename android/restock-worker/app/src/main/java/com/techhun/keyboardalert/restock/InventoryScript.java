package com.techhun.keyboardalert.restock;

import org.json.JSONObject;

import java.util.Locale;

final class InventoryScript {
    private InventoryScript() {}

    static final String SCRIPT = build(null);

    static String build(JSONObject seedProduct) {
        return build(seedProduct, true);
    }

    static String build(JSONObject seedProduct, boolean allowApiFallback) {
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
            const allowApiFallback = %s;

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

            function walkObjects(root, visitor, maxNodes = 40000) {
              const stack = [root];
              const seen = new Set();
              let count = 0;
              while (stack.length && count < maxNodes) {
                const value = stack.pop();
                if (!value || typeof value !== 'object' || seen.has(value)) continue;
                seen.add(value);
                count += 1;
                visitor(value);
                for (const child of Object.values(value)) {
                  if (child && typeof child === 'object') stack.push(child);
                }
              }
            }

            function extractBalancedObject(text, marker) {
              const markerIndex = text.indexOf(marker);
              if (markerIndex < 0) return null;
              const start = text.indexOf('{', markerIndex + marker.length);
              if (start < 0) return null;
              let depth = 0;
              let quote = '';
              let escaped = false;
              for (let index = start; index < text.length; index++) {
                const char = text[index];
                if (quote) {
                  if (escaped) escaped = false;
                  else if (char === '\\\\') escaped = true;
                  else if (char === quote) quote = '';
                  continue;
                }
                if (char === '"' || char === "'") {
                  quote = char;
                  continue;
                }
                if (char === '{') depth += 1;
                else if (char === '}') {
                  depth -= 1;
                  if (depth === 0) return text.slice(start, index + 1);
                }
              }
              return null;
            }

            function collectPageRoots() {
              const roots = [window.__PRELOADED_STATE__, window.__INITIAL_STATE__, window.__NEXT_DATA__]
                .filter(Boolean);
              const captured = Array.isArray(window.__RESTOCK_CAPTURED_RESPONSES__)
                ? window.__RESTOCK_CAPTURED_RESPONSES__
                : [];
              for (const item of captured) {
                if (item && item.data && typeof item.data === 'object') roots.push(item.data);
              }
              const markers = [
                'window.__PRELOADED_STATE__', '__PRELOADED_STATE__',
                'window.__INITIAL_STATE__', '__INITIAL_STATE__',
                'window.__NEXT_DATA__', '__NEXT_DATA__'
              ];
              for (const script of [...document.scripts]) {
                const text = String(script.textContent || '').trim();
                if (!text) continue;
                if (script.type === 'application/json' || script.id === '__NEXT_DATA__') {
                  try { roots.push(JSON.parse(text)); } catch (ignored) {}
                }
                for (const marker of markers) {
                  const chunk = extractBalancedObject(text, marker);
                  if (!chunk) continue;
                  try { roots.push(JSON.parse(chunk)); } catch (ignored) {}
                }
              }
              return roots;
            }

            function productIdentities(value) {
              if (!value || typeof value !== 'object') return [];
              const nested = [value, value.originProduct, value.smartstoreChannelProduct]
                .filter((item) => item && typeof item === 'object');
              const identities = [];
              for (const item of nested) {
                for (const key of ['productNo', 'channelProductNo', 'id']) {
                  const identity = String(item[key] ?? '').trim();
                  if (/^\\d+$/.test(identity) && !identities.includes(identity)) identities.push(identity);
                }
              }
              return identities;
            }

            function optionInfoOf(value) {
              if (!value || typeof value !== 'object') return null;
              const product = value.originProduct && typeof value.originProduct === 'object'
                ? value.originProduct
                : value;
              if (product?.detailAttribute?.optionInfo) return product.detailAttribute.optionInfo;
              if (value?.detailAttribute?.optionInfo) return value.detailAttribute.optionInfo;
              if (value?.optionInfo) return value.optionInfo;
              if (Array.isArray(product?.optionCombinations) || Array.isArray(product?.optionSimple)) return product;
              if (Array.isArray(value?.optionCombinations) || Array.isArray(value?.optionSimple)) return value;
              return null;
            }

            function explicitOptionCount(value) {
              const optionInfo = optionInfoOf(value);
              if (!optionInfo) return 0;
              const combinations = Array.isArray(optionInfo.optionCombinations)
                ? optionInfo.optionCombinations.length
                : 0;
              const simple = Array.isArray(optionInfo.optionSimple)
                ? optionInfo.optionSimple.length
                : 0;
              return combinations + simple;
            }

            function findProductModel(roots, productNo) {
              let exactOptionBest = null;
              let exactOptionScore = -1;
              let titleOptionBest = null;
              let titleOptionScore = -1;
              let exactBest = null;
              let exactScore = -1;
              let fallbackBest = null;
              let fallbackScore = -1;
              for (const root of roots) {
                walkObjects(root, (value) => {
                  let score = 0;
                  if (value.originProduct && typeof value.originProduct === 'object') score += 10;
                  if (value.smartstoreChannelProduct && typeof value.smartstoreChannelProduct === 'object') score += 6;
                  if (value.originProduct?.detailAttribute?.optionInfo) score += 8;
                  if (value.detailAttribute?.optionInfo) score += 8;
                  if (value.optionInfo?.optionCombinations) score += 6;
                  if (Array.isArray(value.optionCombinations)) score += 4;
                  if (value.stockQuantity !== undefined || value.originProduct?.stockQuantity !== undefined) score += 3;
                  const optionCount = explicitOptionCount(value);
                  if (optionCount > 0) score += 20 + Math.min(optionCount, 20);
                  const candidateProduct = value.originProduct && typeof value.originProduct === 'object'
                    ? value.originProduct
                    : value;
                  const candidateName = String(
                    candidateProduct?.name || value.smartstoreChannelProduct?.channelProductName || ''
                  ).trim();
                  const titleMatched = candidateName && document.title.includes(candidateName);
                  if (titleMatched) score += 12;
                  if (score < 4) return;
                  const exact = productIdentities(value).includes(productNo);
                  if (exact && optionCount > 0 && score > exactOptionScore) {
                    exactOptionBest = value;
                    exactOptionScore = score;
                  } else if (!exact && titleMatched && optionCount > 0 && score > titleOptionScore) {
                    titleOptionBest = value;
                    titleOptionScore = score;
                  } else if (exact && score > exactScore) {
                    exactBest = value;
                    exactScore = score;
                  } else if (!exact && titleMatched && score > fallbackScore) {
                    fallbackBest = value;
                    fallbackScore = score;
                  }
                });
              }
              if (exactOptionBest) return { value: exactOptionBest, exact: true };
              if (titleOptionBest) return { value: titleOptionBest, exact: false };
              if (exactBest) return { value: exactBest, exact: true };
              if (fallbackBest) return { value: fallbackBest, exact: false };
              return null;
            }

            function findChannelUid(roots) {
              let found = configuredChannelUid || null;
              if (found) return found;
              for (const root of roots) {
                walkObjects(root, (value) => {
                  if (!found && typeof value.channelUid === 'string' && value.channelUid.length >= 8) {
                    found = value.channelUid;
                  }
                });
                if (found) break;
              }
              if (found) return found;
              const html = document.documentElement?.innerHTML || '';
              const matches = html.matchAll(/channelUid[^A-Za-z0-9_-]{0,40}([A-Za-z0-9_-]{8,80})/g);
              for (const match of matches) {
                const value = match[1];
                if (!value || value === 'broadcastAuthority' || value === 'undefined') continue;
                return value;
              }
              return null;
            }

            function looksLikeProductPayload(data, productNo) {
              if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
              const product = data.originProduct && typeof data.originProduct === 'object' ? data.originProduct : data;
              return !!(
                product?.detailAttribute?.optionInfo
                || data?.detailAttribute?.optionInfo
                || data?.optionInfo
                || Array.isArray(data?.optionCombinations)
                || product?.stockQuantity !== undefined
                || data?.stockQuantity !== undefined
              );
            }

            function snapshot(data, productNo, channelUid, apiUrl, source, exactProductMatch, allowSyntheticDefault) {
              const product = data.originProduct && typeof data.originProduct === 'object'
                ? data.originProduct
                : data;
              const optionInfo = optionInfoOf(data) || data;
              const combinations = Array.isArray(optionInfo?.optionCombinations)
                ? optionInfo.optionCombinations
                : [];
              let options = combinations.map((option, index) => {
                const stock = Number(option.stockQuantity);
                return {
                  id: String(option.id ?? option.optionCombinationId ?? option.combinationId ?? `combination-${index}`),
                  optionName1: option.optionName1 ?? null,
                  optionName2: option.optionName2 ?? null,
                  optionName3: option.optionName3 ?? null,
                  stockQuantity: Number.isFinite(stock) ? stock : null,
                  available: option.usable !== false && Number.isFinite(stock) && stock > 0
                };
              });
              options = options.filter((option, index, all) =>
                option.id && all.findIndex((candidate) => candidate.id === option.id) === index
              );
              if (!options.length && Array.isArray(optionInfo?.optionSimple)) {
                options = optionInfo.optionSimple.map((option, index) => {
                  const stock = Number(option.stockQuantity ?? product?.stockQuantity ?? data?.stockQuantity);
                  return {
                    id: String(option.id ?? option.optionNo ?? `simple-${index}`),
                    optionName1: option.name ?? option.optionName ?? '옵션',
                    optionName2: null,
                    optionName3: null,
                    stockQuantity: Number.isFinite(stock) ? stock : null,
                    available: option.usable !== false && Number.isFinite(stock) && stock > 0
                  };
                });
              }
              const explicitOptionData = options.length > 0;
              if (!options.length && allowSyntheticDefault) {
                const stock = Number(product?.stockQuantity ?? data?.stockQuantity);
                const status = String(product?.statusType || data?.statusType || data?.productStatusType || '').toUpperCase();
                options.push({
                  id: 'default',
                  optionName1: '기본 상품',
                  optionName2: null,
                  optionName3: null,
                  stockQuantity: Number.isFinite(stock) ? stock : null,
                  available: Number.isFinite(stock) ? stock > 0 : status === 'SALE'
                });
              }
              return {
                ok: true,
                source,
                exactProductMatch: exactProductMatch !== false,
                explicitOptionData,
                pageUrl: location.href,
                apiUrl: apiUrl || '',
                title: product?.name || data?.smartstoreChannelProduct?.channelProductName || document.title,
                channelUid: channelUid || '',
                id: product?.id ?? data?.id ?? null,
                productNo,
                statusType: product?.statusType || data?.statusType || data?.productStatusType || null,
                stockQuantity: product?.stockQuantity ?? data?.stockQuantity ?? null,
                optionCombinationCount: options.length,
                options
              };
            }

            try {
              const productMatch = location.pathname.match(/\\/products\\/(\\d+)/);
              const productNo = productMatch ? productMatch[1] : (configuredProductNo || null);
              if (!productNo) {
                send({ ok: false, error: 'PRODUCT_NO_NOT_FOUND', pageUrl: location.href, title: document.title });
                return;
              }

              const roots = collectPageRoots();
              let channelUid = findChannelUid(roots);
              let observedApiUrl = safeNaverApiUrl(configuredApiUrl);
              const capturedResponses = Array.isArray(window.__RESTOCK_CAPTURED_RESPONSES__)
                ? window.__RESTOCK_CAPTURED_RESPONSES__
                : [];
              for (const item of capturedResponses) {
                const candidate = safeNaverApiUrl(item?.url || '');
                if (!candidate) continue;
                try {
                  const parsed = new URL(candidate, location.href);
                  if (parsed.pathname.includes('/products/' + productNo)) observedApiUrl = parsed.toString();
                } catch (ignored) {}
              }
              const resources = performance.getEntriesByType('resource').map((entry) => entry.name || '');
              for (const resourceUrl of resources) {
                try {
                  const parsed = new URL(resourceUrl, location.href);
                  const anyProductMatch = parsed.pathname.match(/^\\/i\\/v2\\/channels\\/([^/]+)\\/products\\/(\\d+)(?:\\/.*)?$/);
                  if (!anyProductMatch) continue;
                  if (!channelUid) channelUid = decodeURIComponent(anyProductMatch[1]);
                  const exactProductMatch = parsed.pathname.match(/^\\/i\\/v2\\/channels\\/([^/]+)\\/products\\/(\\d+)\\/?$/);
                  if (exactProductMatch && exactProductMatch[2] === productNo) observedApiUrl = parsed.toString();
                } catch (ignored) {}
              }

              const pageModel = findProductModel(roots, productNo);
              if (pageModel && looksLikeProductPayload(pageModel.value, productNo)) {
                const pageSnapshot = snapshot(
                  pageModel.value,
                  productNo,
                  channelUid,
                  observedApiUrl,
                  'PAGE_STATE',
                  pageModel.exact,
                  false
                );
                if (pageSnapshot.explicitOptionData && pageSnapshot.options.length > 0) {
                  send(pageSnapshot);
                  return;
                }
              }

              if (!allowApiFallback) {
                send({ ok: false, error: 'API_DEFERRED', pageUrl: location.href, title: document.title });
                return;
              }

              const candidates = [];
              if (observedApiUrl) candidates.push(observedApiUrl);
              if (channelUid) {
                const encodedUid = encodeURIComponent(channelUid);
                candidates.push(`${location.origin}/i/v2/channels/${encodedUid}/products/${productNo}?withWindow=false`);
              }
              if (!candidates.length) {
                send({ ok: false, error: 'PAGE_DATA_NOT_FOUND', pageUrl: location.href, title: document.title });
                return;
              }

              const attempts = [];
              for (const apiUrl of [...new Set(candidates)]) {
                try {
                  const parsed = new URL(apiUrl, location.href);
                  const requestUrl = parsed.origin === location.origin ? parsed.pathname + parsed.search : apiUrl;
                  const response = await fetch(requestUrl, {
                    credentials: 'include',
                    headers: { accept: 'application/json, text/plain, */*' }
                  });
                  const text = await response.text();
                  if (isAuthResponse(response, text)) {
                    send({ ok: false, error: 'AUTH_REQUIRED', status: response.status, pageUrl: location.href, apiUrl, attempts });
                    return;
                  }
                  if (response.status === 204 || response.status === 429) {
                    attempts.push({ url: apiUrl, status: response.status, rateLimited: true });
                    send({ ok: false, error: 'RATE_LIMITED', status: response.status, pageUrl: location.href, apiUrl, attempts });
                    return;
                  }
                  let data = null;
                  try { data = JSON.parse(text); } catch (ignored) {}
                  const validPayload = response.ok && looksLikeProductPayload(data, productNo);
                  attempts.push({ url: apiUrl, status: response.status, validPayload });
                  if (validPayload) {
                    send({ ...snapshot(data, productNo, channelUid, apiUrl, 'API', true, true), attempts });
                    return;
                  }
                } catch (error) {
                  attempts.push({ url: apiUrl, error: String(error) });
                }
              }
              send({ ok: false, error: 'PRODUCT_API_FAILED', pageUrl: location.href, attempts });
            } catch (error) {
              send({ ok: false, error: 'JS_ERROR', message: String(error && (error.stack || error.message) || error) });
            }
          })();
          return 'STARTED';
        })()
        """, configuredApiUrl, configuredChannelUid, configuredProductNo, allowApiFallback);
    }
}
