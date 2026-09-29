package com.techhun.keyboardalert.restock;

final class InventoryRetry {
    private InventoryRetry() {}

    static boolean shouldRetry(String error, int status) {
        if (status == 401 || status == 403 || status == 404 || status == 429) return false;
        if (status == 408 || status >= 500) return true;
        return "CHANNEL_UID_NOT_FOUND".equals(error)
            || "PRODUCT_DATA_NOT_FOUND".equals(error)
            || "PRODUCT_API_FAILED".equals(error)
            || "STATE_UNKNOWN".equals(error)
            || "JS_ERROR".equals(error);
    }
}
