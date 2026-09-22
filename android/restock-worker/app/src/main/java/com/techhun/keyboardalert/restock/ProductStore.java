package com.techhun.keyboardalert.restock;

import android.content.Context;
import android.content.SharedPreferences;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class ProductStore {
    static final String KEY_PRODUCTS = "products_v2";
    private static final Pattern PRODUCT_ID = Pattern.compile("/products/(\\d+)");
    private static final String BACKUP_FORMAT = "restock-backup";
    private static final int BACKUP_VERSION = 1;

    private ProductStore() {}

    static JSONArray list(Context context) {
        migrateLegacyIfNeeded(context);
        try {
            JSONArray products = new JSONArray(MonitorPrefs.prefs(context).getString(KEY_PRODUCTS, "[]"));
            boolean changed = false;
            boolean legacyRunning = MonitorPrefs.prefs(context).getBoolean(MonitorPrefs.KEY_RUNNING, false);
            for (int i = 0; i < products.length(); i++) {
                JSONObject product = products.optJSONObject(i);
                if (product == null) continue;
                if (!product.has("enabled")) {
                    product.put("enabled", legacyRunning);
                    changed = true;
                }
                if (product.optString("siteType", "").isBlank()) {
                    product.put("siteType", SiteSupport.detect(product.optString("url", "")));
                    changed = true;
                }
            }
            if (changed) save(context, products);
            return products;
        } catch (Exception ignored) {
            return new JSONArray();
        }
    }

    static JSONArray enabledList(Context context) {
        JSONArray source = list(context);
        JSONArray enabled = new JSONArray();
        for (int i = 0; i < source.length(); i++) {
            JSONObject product = source.optJSONObject(i);
            if (product != null && product.optBoolean("enabled", false)) enabled.put(product);
        }
        return enabled;
    }

    static int enabledCount(Context context) {
        return enabledList(context).length();
    }

    static void save(Context context, JSONArray products) {
        MonitorPrefs.prefs(context).edit().putString(KEY_PRODUCTS, products.toString()).apply();
    }

    static String idFromUrl(String url) {
        return SiteSupport.productId(url);
    }

    static JSONObject find(Context context, String id) {
        JSONArray products = list(context);
        for (int i = 0; i < products.length(); i++) {
            JSONObject product = products.optJSONObject(i);
            if (product != null && id.equals(product.optString("id"))) return product;
        }
        return null;
    }

    static void upsert(Context context, JSONObject next) {
        JSONArray products = list(context);
        JSONArray updated = new JSONArray();
        String id = next.optString("id");
        boolean replaced = false;
        for (int i = 0; i < products.length(); i++) {
            JSONObject product = products.optJSONObject(i);
            if (product == null) continue;
            if (!replaced && id.equals(product.optString("id"))) {
                preserveRuntime(product, next);
                updated.put(next);
                replaced = true;
            } else {
                updated.put(product);
            }
        }
        if (!replaced) {
            try {
                if (!next.has("enabled")) next.put("enabled", false);
                if (!next.has("lastAvailability")) next.put("lastAvailability", new JSONObject());
                if (!next.has("lastStatus")) next.put("lastStatus", "");
                if (!next.has("lastCheck")) next.put("lastCheck", 0L);
            } catch (Exception ignored) {}
            updated.put(next);
        }
        save(context, updated);
    }

    static void setEnabled(Context context, String id, boolean enabled) {
        if (enabled && !NotificationAccess.isAllowed(context)) {
            Toast.makeText(
                context,
                "알림 권한을 먼저 허용해주세요. 설정에서 알림 권한을 확인할 수 있어요.",
                Toast.LENGTH_SHORT
            ).show();
            return;
        }

        JSONArray products = list(context);
        for (int i = 0; i < products.length(); i++) {
            JSONObject product = products.optJSONObject(i);
            if (product == null || !id.equals(product.optString("id"))) continue;
            try {
                boolean wasEnabled = product.optBoolean("enabled", false);
                product.put("enabled", enabled);
                if (!wasEnabled && enabled) {
                    product.put("lastAvailability", new JSONObject());
                    product.put("lastStatus", "준비 중");
                    product.put("lastCheck", 0L);
                } else if (!enabled) {
                    product.put("lastStatus", "");
                }
            } catch (Exception ignored) {}
            break;
        }
        save(context, products);
    }

    static void disableAll(Context context) {
        JSONArray products = list(context);
        for (int i = 0; i < products.length(); i++) {
            JSONObject product = products.optJSONObject(i);
            if (product == null) continue;
            try {
                product.put("enabled", false);
                product.put("lastStatus", "");
            } catch (Exception ignored) {}
        }
        save(context, products);
    }

    static void disableSite(Context context, String siteType) {
        JSONArray products = list(context);
        for (int i = 0; i < products.length(); i++) {
            JSONObject product = products.optJSONObject(i);
            if (product == null) continue;
            String currentSite = product.optString("siteType", SiteSupport.detect(product.optString("url", "")));
            if (!siteType.equals(currentSite)) continue;
            try {
                product.put("enabled", false);
                product.put("lastStatus", "");
            } catch (Exception ignored) {}
        }
        save(context, products);
    }

    static void updateRuntime(Context context, JSONObject runtime) {
        if (runtime == null) return;
        String id = runtime.optString("id", "");
        if (id.isBlank()) return;
        JSONArray products = list(context);
        for (int i = 0; i < products.length(); i++) {
            JSONObject target = products.optJSONObject(i);
            if (target == null || !id.equals(target.optString("id"))) continue;
            copyIfPresent(runtime, target, "apiUrl");
            copyIfPresent(runtime, target, "channelUid");
            copyIfPresent(runtime, target, "productNo");
            copyIfPresent(runtime, target, "title");
            copyIfPresent(runtime, target, "lastAvailability");
            copyIfPresent(runtime, target, "lastStatus");
            copyIfPresent(runtime, target, "lastCheck");
            break;
        }
        save(context, products);
    }

    static void remove(Context context, String id) {
        JSONArray products = list(context);
        JSONArray updated = new JSONArray();
        for (int i = 0; i < products.length(); i++) {
            JSONObject product = products.optJSONObject(i);
            if (product == null || id.equals(product.optString("id"))) continue;
            updated.put(product);
        }
        save(context, updated);
    }

    static int selectedCount(JSONObject product) {
        JSONArray ids = product == null ? null : product.optJSONArray("selectedIds");
        return ids == null ? 0 : ids.length();
    }

    static String exportBackup(Context context) throws Exception {
        JSONObject root = new JSONObject();
        root.put("format", BACKUP_FORMAT);
        root.put("version", BACKUP_VERSION);
        root.put("intervalSeconds", MonitorPrefs.intervalSeconds(context));

        JSONArray exported = new JSONArray();
        JSONArray products = list(context);
        for (int i = 0; i < products.length(); i++) {
            JSONObject source = products.optJSONObject(i);
            if (source == null) continue;
            JSONObject item = new JSONObject();
            copyIfPresent(source, item, "id");
            copyIfPresent(source, item, "url");
            copyIfPresent(source, item, "title");
            copyIfPresent(source, item, "selectedIds");
            copyIfPresent(source, item, "selectedLabels");
            copyIfPresent(source, item, "apiUrl");
            copyIfPresent(source, item, "channelUid");
            copyIfPresent(source, item, "productNo");
            copyIfPresent(source, item, "siteType");
            item.put("enabled", source.optBoolean("enabled", false));
            exported.put(item);
        }
        root.put("products", exported);
        return root.toString(2);
    }

    static int importBackup(Context context, String json) throws Exception {
        JSONObject root = new JSONObject(json);
        if (!BACKUP_FORMAT.equals(root.optString("format", ""))) {
            throw new IllegalArgumentException("지원하지 않는 백업 파일입니다.");
        }
        JSONArray source = root.optJSONArray("products");
        if (source == null) throw new IllegalArgumentException("상품 목록이 없습니다.");

        boolean canEnable = NotificationAccess.isAllowed(context);
        JSONArray imported = new JSONArray();
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < source.length(); i++) {
            JSONObject item = source.optJSONObject(i);
            if (item == null) continue;
            String url = item.optString("url", "").trim();
            if (!isSupportedProductUrl(url)) continue;

            JSONArray ids = item.optJSONArray("selectedIds");
            if (ids == null || ids.length() == 0) continue;
            String id = item.optString("id", "").trim();
            if (id.isBlank()) id = idFromUrl(url);
            if (!seen.add(id)) continue;

            JSONObject restored = new JSONObject();
            restored.put("id", id);
            restored.put("url", url);
            restored.put("title", item.optString("title", "SmartStore 상품"));
            restored.put("selectedIds", new JSONArray(ids.toString()));
            JSONObject labels = item.optJSONObject("selectedLabels");
            restored.put("selectedLabels", labels == null ? new JSONObject() : new JSONObject(labels.toString()));
            restored.put("apiUrl", item.optString("apiUrl", ""));
            restored.put("channelUid", item.optString("channelUid", ""));
            restored.put("productNo", item.optString("productNo", ""));
            String siteType = item.optString("siteType", SiteSupport.detect(url));
            if (SiteSupport.UNKNOWN.equals(siteType)) siteType = SiteSupport.detect(url);
            restored.put("siteType", siteType);
            boolean enabled = item.optBoolean("enabled", false) && canEnable;
            restored.put("enabled", enabled);
            restored.put("lastAvailability", new JSONObject());
            restored.put("lastStatus", enabled ? "준비 중" : "");
            restored.put("lastCheck", 0L);
            imported.put(restored);
        }

        int interval = root.optInt("intervalSeconds", MonitorPrefs.intervalSeconds(context));
        if (interval != 15 && interval != 30 && interval != 60) interval = 30;
        MonitorPrefs.prefs(context).edit().putInt(MonitorPrefs.KEY_INTERVAL, interval).apply();
        save(context, imported);
        return imported.length();
    }

    static void migrateLegacyIfNeeded(Context context) {
        SharedPreferences prefs = MonitorPrefs.prefs(context);
        if (prefs.contains(KEY_PRODUCTS)) return;
        String url = prefs.getString(MonitorPrefs.KEY_URL, "");
        JSONArray products = new JSONArray();
        if (!url.isBlank()) {
            try {
                JSONArray ids = new JSONArray(prefs.getString(MonitorPrefs.KEY_SELECTED_IDS, "[]"));
                if (ids.length() > 0) {
                    JSONObject product = new JSONObject();
                    product.put("id", idFromUrl(url));
                    product.put("url", url);
                    product.put("title", prefs.getString(MonitorPrefs.KEY_TITLE, "SmartStore 상품"));
                    product.put("selectedIds", ids);
                    product.put("selectedLabels", new JSONObject(prefs.getString(MonitorPrefs.KEY_SELECTED_LABELS, "{}")));
                    product.put("lastAvailability", new JSONObject(prefs.getString(MonitorPrefs.KEY_LAST_AVAILABILITY, "{}")));
                    product.put("lastStatus", prefs.getString(MonitorPrefs.KEY_LAST_STATUS, ""));
                    product.put("lastCheck", prefs.getLong(MonitorPrefs.KEY_LAST_CHECK, 0L));
                    product.put("enabled", prefs.getBoolean(MonitorPrefs.KEY_RUNNING, false));
                    products.put(product);
                }
            } catch (Exception ignored) {}
        }
        prefs.edit().putString(KEY_PRODUCTS, products.toString()).apply();
    }

    private static boolean isSupportedProductUrl(String url) {
        return SiteSupport.isSupportedProductUrl(url);
    }

    private static void preserveRuntime(JSONObject oldProduct, JSONObject next) {
        try {
            next.put("enabled", oldProduct.optBoolean("enabled", false));
            JSONArray oldIds = oldProduct.optJSONArray("selectedIds");
            JSONArray nextIds = next.optJSONArray("selectedIds");
            boolean sameSelection = oldIds != null && nextIds != null && oldIds.toString().equals(nextIds.toString());
            if (sameSelection) {
                next.put("lastAvailability", oldProduct.optJSONObject("lastAvailability") == null ? new JSONObject() : oldProduct.optJSONObject("lastAvailability"));
                next.put("lastStatus", oldProduct.optString("lastStatus", ""));
                next.put("lastCheck", oldProduct.optLong("lastCheck", 0L));
            } else {
                next.put("lastAvailability", new JSONObject());
                next.put("lastStatus", oldProduct.optBoolean("enabled", false) ? "준비 중" : "");
                next.put("lastCheck", 0L);
            }
        } catch (Exception ignored) {}
    }

    private static void copyIfPresent(JSONObject source, JSONObject target, String key) {
        if (!source.has(key)) return;
        try { target.put(key, source.opt(key)); } catch (Exception ignored) {}
    }
}
