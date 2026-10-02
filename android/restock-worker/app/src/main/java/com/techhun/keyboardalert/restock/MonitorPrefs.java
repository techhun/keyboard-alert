package com.techhun.keyboardalert.restock;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class MonitorPrefs {
    static final String NAME = "restock_monitor";
    static final String KEY_URL = "url";
    static final String KEY_TITLE = "title";
    static final String KEY_SELECTED_IDS = "selected_ids";
    static final String KEY_SELECTED_LABELS = "selected_labels";
    static final String KEY_INTERVAL = "interval_seconds";
    static final String KEY_LOW_STOCK_THRESHOLD = "low_stock_threshold";
    static final String KEY_LOW_STOCK_THRESHOLD = "low_stock_threshold";
    static final String KEY_RUNNING = "running";
    static final String KEY_LAST_STATUS = "last_status";
    static final String KEY_LAST_CHECK = "last_check";
    static final String KEY_LAST_AVAILABILITY = "last_availability";

    private MonitorPrefs() {}

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(NAME, Context.MODE_PRIVATE);
    }

    static void saveConfig(Context context, String url, String title, List<String> ids, Map<String, String> labels, int intervalSeconds) {
        JSONArray idArray = new JSONArray();
        for (String id : ids) idArray.put(id);
        JSONObject labelObject = new JSONObject();
        for (Map.Entry<String, String> entry : labels.entrySet()) {
            try { labelObject.put(entry.getKey(), entry.getValue()); } catch (Exception ignored) {}
        }

        SharedPreferences preferences = prefs(context);
        String nextIds = idArray.toString();
        boolean targetChanged = !url.equals(preferences.getString(KEY_URL, ""))
            || !nextIds.equals(preferences.getString(KEY_SELECTED_IDS, "[]"));

        SharedPreferences.Editor editor = preferences.edit()
            .putString(KEY_URL, url)
            .putString(KEY_TITLE, title)
            .putString(KEY_SELECTED_IDS, nextIds)
            .putString(KEY_SELECTED_LABELS, labelObject.toString())
            .putInt(KEY_INTERVAL, intervalSeconds);
        if (targetChanged) editor.remove(KEY_LAST_AVAILABILITY);
        editor.apply();
    }

    static List<String> selectedIds(Context context) {
        List<String> result = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(prefs(context).getString(KEY_SELECTED_IDS, "[]"));
            for (int i = 0; i < array.length(); i++) {
                String value = array.optString(i, "");
                if (!value.isBlank()) result.add(value);
            }
        } catch (Exception ignored) {}
        return result;
    }

    static Map<String, String> selectedLabels(Context context) {
        Map<String, String> result = new LinkedHashMap<>();
        try {
            JSONObject object = new JSONObject(prefs(context).getString(KEY_SELECTED_LABELS, "{}"));
            var keys = object.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                result.put(key, object.optString(key, key));
            }
        } catch (Exception ignored) {}
        return result;
    }

    static int intervalSeconds(Context context) {
        return Math.max(15, prefs(context).getInt(KEY_INTERVAL, 30));
    }

    static int lowStockThreshold(Context context) {
        int value = prefs(context).getInt(KEY_LOW_STOCK_THRESHOLD, 5);
        return value >= 1 && value <= 999 ? value : 5;
    }

    static int lowStockThreshold(Context context) {
        int value = prefs(context).getInt(KEY_LOW_STOCK_THRESHOLD, 5);
        return value >= 1 && value <= 999 ? value : 5;
    }

    static void setRunning(Context context, boolean running) {
        prefs(context).edit().putBoolean(KEY_RUNNING, running).apply();
    }

    static void updateStatus(Context context, String status) {
        prefs(context).edit()
            .putString(KEY_LAST_STATUS, status)
            .putLong(KEY_LAST_CHECK, System.currentTimeMillis())
            .apply();
    }
}
