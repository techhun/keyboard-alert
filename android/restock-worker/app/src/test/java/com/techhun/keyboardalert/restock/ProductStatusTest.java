package com.techhun.keyboardalert.restock;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public class ProductStatusTest {
    private static JSONObject product(boolean enabled, long lastCheck, long lastSuccess) throws Exception {
        JSONObject product = new JSONObject();
        product.put("id", "123");
        product.put("enabled", enabled);
        product.put("lastCheck", lastCheck);
        product.put("lastSuccess", lastSuccess);
        return product;
    }

    @Test
    public void disabledProductIsOff() throws Exception {
        assertEquals(ProductStatus.OFF, ProductStatus.stateOf(product(false, 1_000L, 1_000L)));
    }

    @Test
    public void enabledProductWithoutCheckIsPending() throws Exception {
        assertEquals(ProductStatus.PENDING, ProductStatus.stateOf(product(true, 0L, 0L)));
    }

    @Test
    public void failedCheckIsDetectedWhenSuccessIsOlder() throws Exception {
        JSONObject product = product(true, 2_000L, 1_000L);
        assertTrue(ProductStatus.isFailure(product));
        assertEquals(ProductStatus.FAILED, ProductStatus.stateOf(product));
    }

    @Test
    public void structuredResultWinsOverTimestamps() throws Exception {
        JSONObject product = product(true, 2_000L, 1_000L);
        product.put("lastResult", "OK");
        assertFalse(ProductStatus.isFailure(product));
    }

    @Test
    public void soldOutOptionsReportOutOfStock() throws Exception {
        JSONObject product = product(true, 2_000L, 2_000L);
        product.put("selectedIds", new JSONArray().put("a").put("b"));
        product.put("lastAvailability", new JSONObject().put("a", false).put("b", false));
        assertEquals(0, ProductStatus.availableCount(product));
        assertEquals(ProductStatus.OUT_OF_STOCK, ProductStatus.stateOf(product));
    }

    @Test
    public void availableOptionReportsOk() throws Exception {
        JSONObject product = product(true, 2_000L, 2_000L);
        product.put("selectedIds", new JSONArray().put("a").put("b"));
        product.put("lastAvailability", new JSONObject().put("a", true).put("b", false));
        assertEquals(1, ProductStatus.availableCount(product));
        assertEquals(2, ProductStatus.requestedCount(product));
        assertEquals(ProductStatus.OK, ProductStatus.stateOf(product));
    }

    @Test
    public void failureReasonDropsThePreservedStockTail() throws Exception {
        JSONObject product = product(true, 2_000L, 1_000L);
        product.put("lastStatus", "HTTP 429 요청 제한 · 30초 후 재시도 · 이전 재고 보존 (12:58)");
        assertEquals("HTTP 429 요청 제한 · 30초 후 재시도", ProductStatus.failureReason(product));
    }

    @Test
    public void relativeTimeCoversMinutesHoursAndDays() {
        long now = 10_000_000_000L;
        assertEquals("방금 전", ProductStatus.relativeTime(now - 20_000L, now));
        assertEquals("3분 전", ProductStatus.relativeTime(now - 3 * 60_000L, now));
        assertEquals("2시간 전", ProductStatus.relativeTime(now - 2 * 3_600_000L, now));
        assertEquals("3일 전", ProductStatus.relativeTime(now - 3 * 86_400_000L, now));
        assertEquals("", ProductStatus.relativeTime(0L, now));
    }

    @Test
    public void listHelpersCountOnlyEnabledProducts() throws Exception {
        JSONObject off = product(false, 5_000L, 5_000L);
        off.put("id", "off");
        JSONObject ok = product(true, 3_000L, 3_000L);
        ok.put("id", "ok");
        ok.put("lastAvailability", new JSONObject().put("a", true));
        JSONObject failed = product(true, 4_000L, 1_000L);
        failed.put("id", "failed");
        JSONArray products = new JSONArray().put(off).put(ok).put(failed);

        assertEquals(2, ProductStatus.enabledCount(products));
        assertEquals(1, ProductStatus.failureCount(products));
        assertEquals(4_000L, ProductStatus.latestCheck(products));
    }
}
