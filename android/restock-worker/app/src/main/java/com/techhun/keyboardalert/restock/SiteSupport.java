package com.techhun.keyboardalert.restock;

import android.net.Uri;

final class SiteSupport {
    static final String NAVER_SMARTSTORE = "naver_smartstore";
    static final String SWAGKEY_IMWEB = "swagkey_imweb";
    static final String UNKNOWN = "unknown";

    private SiteSupport() {}

    static String detect(String url) {
        try {
            Uri uri = Uri.parse(url == null ? "" : url.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme())) return UNKNOWN;
            String host = normalizeHost(uri.getHost());
            if (isNaverHost(host) && pathContainsProduct(uri.getPath())) return NAVER_SMARTSTORE;
            if (isSwagkeyHost(host) && swagkeyProductId(uri) != null) return SWAGKEY_IMWEB;
        } catch (Exception ignored) {}
        return UNKNOWN;
    }

    static boolean isSupportedProductUrl(String url) {
        return !UNKNOWN.equals(detect(url));
    }

    static boolean isAllowedPage(String siteType, String url) {
        if (url == null || url.isBlank()) return false;
        if ("about:blank".equalsIgnoreCase(url)) return true;
        try {
            Uri uri = Uri.parse(url);
            if (!"https".equalsIgnoreCase(uri.getScheme())) return false;
            String host = normalizeHost(uri.getHost());
            if (NAVER_SMARTSTORE.equals(siteType)) return isNaverHost(host);
            if (SWAGKEY_IMWEB.equals(siteType)) return isSwagkeyHost(host);
        } catch (Exception ignored) {}
        return false;
    }

    static boolean isProductPage(String siteType, String url) {
        if (!isAllowedPage(siteType, url)) return false;
        try {
            Uri uri = Uri.parse(url);
            if (NAVER_SMARTSTORE.equals(siteType)) return pathContainsProduct(uri.getPath());
            if (SWAGKEY_IMWEB.equals(siteType)) return swagkeyProductId(uri) != null;
        } catch (Exception ignored) {}
        return false;
    }

    static boolean isNaverLoginUrl(String url) {
        try {
            Uri uri = Uri.parse(url == null ? "" : url);
            if (!"https".equalsIgnoreCase(uri.getScheme())) return false;
            String host = normalizeHost(uri.getHost());
            return host.equals("nid.naver.com") || host.endsWith(".nid.naver.com");
        } catch (Exception ignored) {
            return false;
        }
    }

    static String productId(String url) {
        String siteType = detect(url);
        try {
            Uri uri = Uri.parse(url);
            if (NAVER_SMARTSTORE.equals(siteType)) {
                String path = uri.getPath();
                if (path != null) {
                    String[] parts = path.split("/");
                    for (int i = 0; i < parts.length - 1; i++) {
                        if ("products".equals(parts[i]) && parts[i + 1].matches("\\d+")) return parts[i + 1];
                    }
                }
            }
            if (SWAGKEY_IMWEB.equals(siteType)) {
                String id = swagkeyProductId(uri);
                if (id != null) return "swagkey-" + id;
            }
        } catch (Exception ignored) {}
        return "url-" + Math.abs((url == null ? "" : url).hashCode());
    }

    static String label(String siteType) {
        if (SWAGKEY_IMWEB.equals(siteType)) return "SWAGKEY";
        if (NAVER_SMARTSTORE.equals(siteType)) return "SmartStore";
        return "지원 사이트";
    }

    private static boolean pathContainsProduct(String path) {
        return path != null && path.matches(".*?/products/\\d+(?:/.*)?");
    }

    private static String swagkeyProductId(Uri uri) {
        String idx = uri.getQueryParameter("idx");
        if (idx != null && idx.matches("\\d+")) return idx;
        String path = uri.getPath();
        if (path != null) {
            String[] parts = path.split("/");
            for (int i = 0; i < parts.length - 1; i++) {
                if ("shop_view".equals(parts[i]) && parts[i + 1].matches("\\d+")) return parts[i + 1];
            }
        }
        return null;
    }

    private static boolean isNaverHost(String host) {
        return host.equals("smartstore.naver.com") || host.endsWith(".smartstore.naver.com");
    }

    private static boolean isSwagkeyHost(String host) {
        return host.equals("swagkey.kr") || host.equals("www.swagkey.kr");
    }

    private static String normalizeHost(String host) {
        return host == null ? "" : host.toLowerCase(java.util.Locale.ROOT);
    }
}
