package com.techhun.keyboardalert.restock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Iterator;
import java.util.Locale;

/**
 * 저장된 상품 레코드에서 화면이 쓸 상태를 계산한다.
 * MonitorService가 기록하는 값(lastCheck · lastSuccess · lastAvailability · lastStatus)만 읽고,
 * 화면은 이 결과로 배지·요약 문구를 고른다.
 */
final class ProductStatus {
    static final int OFF = 0;
    static final int PENDING = 1;
    static final int OK = 2;
    static final int OUT_OF_STOCK = 3;
    static final int FAILED = 4;

    private ProductStatus() {}

    static int stateOf(JSONObject product) {
        if (product == null) return OFF;
        if (!product.optBoolean("enabled", false)) return OFF;
        if (isFailure(product)) return FAILED;
        if (product.optLong("lastCheck", 0L) <= 0L) return PENDING;
        if (requestedCount(product) > 0 && availableCount(product) <= 0) return OUT_OF_STOCK;
        return OK;
    }

    /**
     * 성공 조회는 lastCheck와 lastSuccess를 같은 값으로 남기고, 실패는 lastCheck만 갱신한다.
     * 최신 스키마(lastResult)가 있으면 그 값을 먼저 쓴다.
     */
    static boolean isFailure(JSONObject product) {
        if (product == null) return false;
        String result = product.optString("lastResult", "");
        if ("FAIL".equals(result)) return true;
        if ("OK".equals(result)) return false;
        long check = product.optLong("lastCheck", 0L);
        long success = product.optLong("lastSuccess", 0L);
        return check > 0L && success < check;
    }

    static int requestedCount(JSONObject product) {
        JSONArray ids = product == null ? null : product.optJSONArray("selectedIds");
        return ids == null ? 0 : ids.length();
    }

    static int availableCount(JSONObject product) {
        JSONObject availability = product == null ? null : product.optJSONObject("lastAvailability");
        if (availability == null) return 0;
        int count = 0;
        Iterator<String> keys = availability.keys();
        while (keys.hasNext()) {
            if (availability.optBoolean(keys.next(), false)) count++;
        }
        return count;
    }

    /** 실패 사유 한 줄. "이전 재고 보존 (시각)" 꼬리는 화면에서 따로 보여 주므로 잘라 낸다. */
    static String failureReason(JSONObject product) {
        if (product == null) return "";
        String error = product.optString("lastError", "");
        if (!error.isBlank()) return error;
        String status = product.optString("lastStatus", "");
        int cut = status.indexOf(" · 이전 재고 보존");
        if (cut > 0) status = status.substring(0, cut);
        return status.isBlank() ? "확인 실패" : status;
    }

    static int enabledCount(JSONArray products) {
        if (products == null) return 0;
        int count = 0;
        for (int i = 0; i < products.length(); i++) {
            JSONObject product = products.optJSONObject(i);
            if (product != null && product.optBoolean("enabled", false)) count++;
        }
        return count;
    }

    /** 알림이 켜져 있으면서 마지막 확인이 실패한 상품 수. */
    static int failureCount(JSONArray products) {
        if (products == null) return 0;
        int count = 0;
        for (int i = 0; i < products.length(); i++) {
            JSONObject product = products.optJSONObject(i);
            if (product == null || !product.optBoolean("enabled", false)) continue;
            if (isFailure(product)) count++;
        }
        return count;
    }

    /** 알림이 켜진 상품 중 가장 최근 확인 시각. 없으면 0. */
    static long latestCheck(JSONArray products) {
        if (products == null) return 0L;
        long latest = 0L;
        for (int i = 0; i < products.length(); i++) {
            JSONObject product = products.optJSONObject(i);
            if (product == null || !product.optBoolean("enabled", false)) continue;
            latest = Math.max(latest, product.optLong("lastCheck", 0L));
        }
        return latest;
    }

    /** "방금 전 · 3분 전 · 2시간 전 · 3일 전". 기록이 없으면 빈 문자열. */
    static String relativeTime(long timestamp, long now) {
        if (timestamp <= 0L) return "";
        long delta = Math.max(0L, now - timestamp) / 1000L;
        if (delta < 60L) return "방금 전";
        long minutes = delta / 60L;
        if (minutes < 60L) return minutes + "분 전";
        long hours = minutes / 60L;
        if (hours < 24L) return hours + "시간 전";
        return (hours / 24L) + "일 전";
    }

    static String clockTime(long timestamp) {
        if (timestamp <= 0L) return "";
        return new SimpleDateFormat("HH:mm", Locale.KOREA).format(new Date(timestamp));
    }
}
