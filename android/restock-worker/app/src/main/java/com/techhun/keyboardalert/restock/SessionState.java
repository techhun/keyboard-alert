package com.techhun.keyboardalert.restock;

import android.content.Context;
import android.webkit.CookieManager;

final class SessionState {
    static final String SMARTSTORE_HOME = "https://m.smartstore.naver.com/";
    private static final String KEY_NAVER_AUTH_REQUIRED = "naver_auth_required";
    private static final String KEY_GUEST_MODE = "guest_mode";

    private SessionState() {}

    static boolean hasNaverSession() {
        CookieManager manager = CookieManager.getInstance();
        String cookie = manager.getCookie("https://naver.com");
        if (cookie == null || cookie.isBlank()) cookie = manager.getCookie(SMARTSTORE_HOME);
        if (cookie == null || cookie.isBlank()) return false;
        return hasCookieValue(cookie, "NID_SES") || hasCookieValue(cookie, "NID_AUT");
    }

    static boolean hasUsableNaverSession(Context context) {
        return hasNaverSession() && !isNaverAuthRequired(context);
    }

    static boolean isNaverAuthRequired(Context context) {
        return MonitorPrefs.prefs(context).getBoolean(KEY_NAVER_AUTH_REQUIRED, false);
    }

    static boolean isGuestMode(Context context) {
        return MonitorPrefs.prefs(context).getBoolean(KEY_GUEST_MODE, false);
    }

    static void markNaverAuthRequired(Context context) {
        MonitorPrefs.prefs(context).edit()
            .putBoolean(KEY_NAVER_AUTH_REQUIRED, true)
            .putBoolean(KEY_GUEST_MODE, false)
            .apply();
    }

    static void markNaverAuthenticated(Context context) {
        MonitorPrefs.prefs(context).edit()
            .putBoolean(KEY_NAVER_AUTH_REQUIRED, false)
            .putBoolean(KEY_GUEST_MODE, false)
            .apply();
    }

    static void enterGuestMode(Context context) {
        MonitorPrefs.prefs(context).edit()
            .putBoolean(KEY_GUEST_MODE, true)
            .apply();
    }

    static void clearForLogout(Context context) {
        MonitorPrefs.prefs(context).edit()
            .putBoolean(KEY_NAVER_AUTH_REQUIRED, false)
            .putBoolean(KEY_GUEST_MODE, false)
            .apply();
    }

    static boolean shouldShowGate(Context context) {
        return shouldShowGate(hasNaverSession(), isNaverAuthRequired(context), isGuestMode(context));
    }

    static boolean shouldShowGate(boolean hasSession, boolean authRequired, boolean guestMode) {
        return !guestMode && (!hasSession || authRequired);
    }

    private static boolean hasCookieValue(String cookie, String name) {
        String prefix = name + "=";
        for (String token : cookie.split(";")) {
            String value = token.trim();
            if (!value.startsWith(prefix)) continue;
            String content = value.substring(prefix.length()).trim();
            return !content.isBlank() && !"deleted".equalsIgnoreCase(content);
        }
        return false;
    }
}
