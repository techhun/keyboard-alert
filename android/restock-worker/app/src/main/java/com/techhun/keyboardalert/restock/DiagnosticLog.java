package com.techhun.keyboardalert.restock;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

final class DiagnosticLog {
    private static final String NAME = "restock_diagnostics";
    private static final String KEY_ENTRIES = "entries";
    private static final String KEY_SUCCESS = "success_count";
    private static final String KEY_FAILURE = "failure_count";
    private static final String KEY_RATE_LIMIT = "rate_limit_count";
    private static final String KEY_TIMEOUT = "timeout_count";
    private static final String KEY_BLOCKED_NAV = "blocked_nav_count";
    private static final String KEY_RESTOCK = "restock_count";
    private static final String KEY_SINCE = "since";
    private static final String KEY_LAST_SUCCESS = "last_success";
    private static final int MAX_ENTRIES = 500;
    private static final long RETENTION_MS = 7L * 24L * 60L * 60L * 1000L;

    private DiagnosticLog() {}

    static void recordSuccess(Context context) {
        SharedPreferences p = prefs(context);
        long now = System.currentTimeMillis();
        ensureSince(p, now);
        p.edit()
            .putLong(KEY_SUCCESS, p.getLong(KEY_SUCCESS, 0L) + 1L)
            .putLong(KEY_LAST_SUCCESS, now)
            .apply();
    }

    static void recordFailure(Context context, String event, JSONObject product, String detail) {
        SharedPreferences p = prefs(context);
        ensureSince(p, System.currentTimeMillis());
        p.edit().putLong(KEY_FAILURE, p.getLong(KEY_FAILURE, 0L) + 1L).apply();
        add(context, event, product, detail);
    }

    static void recordRateLimit(Context context, JSONObject product, String detail) {
        SharedPreferences p = prefs(context);
        ensureSince(p, System.currentTimeMillis());
        p.edit()
            .putLong(KEY_FAILURE, p.getLong(KEY_FAILURE, 0L) + 1L)
            .putLong(KEY_RATE_LIMIT, p.getLong(KEY_RATE_LIMIT, 0L) + 1L)
            .apply();
        add(context, "RATE_LIMIT", product, detail);
    }

    static void recordTimeout(Context context, JSONObject product) {
        SharedPreferences p = prefs(context);
        ensureSince(p, System.currentTimeMillis());
        p.edit()
            .putLong(KEY_FAILURE, p.getLong(KEY_FAILURE, 0L) + 1L)
            .putLong(KEY_TIMEOUT, p.getLong(KEY_TIMEOUT, 0L) + 1L)
            .apply();
        add(context, "TIMEOUT", product, "20초 내 응답 없음");
    }

    static void recordBlockedNavigation(Context context, JSONObject product, String host) {
        SharedPreferences p = prefs(context);
        ensureSince(p, System.currentTimeMillis());
        p.edit().putLong(KEY_BLOCKED_NAV, p.getLong(KEY_BLOCKED_NAV, 0L) + 1L).apply();
        add(context, "BLOCKED_NAV", product, host);
    }

    static void recordRestock(Context context, JSONObject product, String detail) {
        SharedPreferences p = prefs(context);
        ensureSince(p, System.currentTimeMillis());
        p.edit().putLong(KEY_RESTOCK, p.getLong(KEY_RESTOCK, 0L) + 1L).apply();
        add(context, "RESTOCK", product, detail);
    }

    static synchronized void add(Context context, String event, JSONObject product, String detail) {
        try {
            JSONArray source = read(context);
            JSONArray next = new JSONArray();
            long cutoff = System.currentTimeMillis() - RETENTION_MS;
            for (int i = 0; i < source.length(); i++) {
                JSONObject item = source.optJSONObject(i);
                if (item == null || item.optLong("ts", 0L) < cutoff) continue;
                next.put(item);
            }

            JSONObject item = new JSONObject();
            item.put("ts", System.currentTimeMillis());
            item.put("event", safe(event, 48));
            if (product != null) {
                String site = product.optString("siteType", SiteSupport.detect(product.optString("url", "")));
                item.put("site", site);
                item.put("productId", safe(product.optString("id", ""), 80));
                item.put("title", safe(product.optString("title", ""), 80));
            }
            if (detail != null && !detail.isBlank()) item.put("detail", safe(detail, 180));
            next.put(item);

            int start = Math.max(0, next.length() - MAX_ENTRIES);
            JSONArray trimmed = new JSONArray();
            for (int i = start; i < next.length(); i++) trimmed.put(next.optJSONObject(i));
            prefs(context).edit().putString(KEY_ENTRIES, trimmed.toString()).apply();
        } catch (Exception ignored) {}
    }

    static synchronized JSONArray read(Context context) {
        try {
            return new JSONArray(prefs(context).getString(KEY_ENTRIES, "[]"));
        } catch (Exception ignored) {
            return new JSONArray();
        }
    }

    static synchronized void clear(Context context) {
        prefs(context).edit().clear().apply();
    }

    static String summary(Context context) {
        SharedPreferences p = prefs(context);
        long success = p.getLong(KEY_SUCCESS, 0L);
        long failure = p.getLong(KEY_FAILURE, 0L);
        long total = success + failure;
        StringBuilder out = new StringBuilder();
        out.append("정상 ").append(success)
            .append(" · 실패 ").append(failure)
            .append(" · 429 ").append(p.getLong(KEY_RATE_LIMIT, 0L))
            .append(" · 타임아웃 ").append(p.getLong(KEY_TIMEOUT, 0L))
            .append("\n차단 ").append(p.getLong(KEY_BLOCKED_NAV, 0L))
            .append(" · 재입고 ").append(p.getLong(KEY_RESTOCK, 0L));
        if (total > 0) {
            double rate = success * 100.0 / total;
            out.append(" · 성공률 ").append(String.format(Locale.KOREA, "%.1f%%", rate));
        }
        long last = p.getLong(KEY_LAST_SUCCESS, 0L);
        if (last > 0) {
            out.append("\n마지막 정상 조회 ")
                .append(new SimpleDateFormat("MM-dd HH:mm:ss", Locale.KOREA).format(new Date(last)));
        }
        return out.toString();
    }

    static String formatRecent(Context context, int limit) {
        JSONArray entries = read(context);
        if (entries.length() == 0) return "저장된 이벤트 로그가 없어요.";
        StringBuilder out = new StringBuilder();
        SimpleDateFormat format = new SimpleDateFormat("MM-dd HH:mm:ss", Locale.KOREA);
        int start = Math.max(0, entries.length() - Math.max(1, limit));
        for (int i = entries.length() - 1; i >= start; i--) {
            JSONObject item = entries.optJSONObject(i);
            if (item == null) continue;
            if (out.length() > 0) out.append("\n");
            out.append(format.format(new Date(item.optLong("ts", 0L))))
                .append(" · ")
                .append(item.optString("event", "EVENT"));
            String site = item.optString("site", "");
            if (!site.isBlank()) out.append(" · ").append(SiteSupport.label(site));
            String title = item.optString("title", "");
            if (!title.isBlank()) out.append("\n  ").append(title);
            String detail = item.optString("detail", "");
            if (!detail.isBlank()) out.append("\n  ").append(detail);
        }
        return out.toString();
    }

    static int count(Context context) {
        return read(context).length();
    }

    private static void ensureSince(SharedPreferences p, long now) {
        if (p.getLong(KEY_SINCE, 0L) == 0L) p.edit().putLong(KEY_SINCE, now).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(NAME, Context.MODE_PRIVATE);
    }

    private static String safe(String value, int max) {
        if (value == null) return "";
        String cleaned = value.replace('\n', ' ').replace('\r', ' ').trim();
        return cleaned.length() <= max ? cleaned : cleaned.substring(0, max);
    }
}
