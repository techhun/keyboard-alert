package com.techhun.keyboardalert.restock;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class MonitorServiceTest {
    @Test
    public void productSpacingKeepsFiveSecondSafetyFloor() {
        assertEquals(5_000L, MonitorService.productSpacingMillis(10, 2));
        assertEquals(7_500L, MonitorService.productSpacingMillis(15, 2));
        assertEquals(5_000L, MonitorService.productSpacingMillis(5, 2));
        assertEquals(5_000L, MonitorService.productSpacingMillis(15, 7));
        assertEquals(15_000L, MonitorService.productSpacingMillis(15, 1));
        assertEquals(30_000L, MonitorService.productSpacingMillis(60, 2));
    }

    @Test
    public void document429TriggersCooldownButScriptErrorsAndOtherProductsDoNot() {
        String monitored = "https://m.smartstore.naver.com/example/products/123";
        assertTrue(MonitorService.isSmartStoreDocumentRateLimit(true, 429, monitored, monitored));
        assertFalse(MonitorService.isSmartStoreDocumentRateLimit(false, 429, monitored, monitored));
        assertFalse(MonitorService.isSmartStoreDocumentRateLimit(true, 204, monitored, monitored));
        assertFalse(MonitorService.isSmartStoreDocumentRateLimit(true, 429, monitored,
            "https://m.smartstore.naver.com/example/products/456"));
        assertFalse(MonitorService.isSmartStoreDocumentRateLimit(true, 429, monitored,
            "https://nid.naver.com/nidlogin.login"));
    }

    @Test
    public void repeated429RetainsPenaltyAcrossSuccessButResetsAfterTenMinutes() {
        long now = 1_800_000_000_000L;
        assertEquals(30_000L, MonitorService.rateLimitDelayMillis(0L, 0L, now, 429));
        assertEquals(60_000L, MonitorService.rateLimitDelayMillis(30_000L, now - 60_000L, now, 429));
        assertEquals(120_000L, MonitorService.rateLimitDelayMillis(60_000L, now - 120_000L, now, 429));
        assertEquals(30_000L, MonitorService.rateLimitDelayMillis(120_000L, now - 600_001L, now, 429));
        assertEquals(30_000L, MonitorService.rateLimitDelayMillis(120_000L, now + 1L, now, 429));
        assertEquals(5 * 60_000L, MonitorService.rateLimitDelayMillis(0L, 0L, now, 204));
        assertEquals(30 * 60_000L, MonitorService.rateLimitDelayMillis(30 * 60_000L,
            now - 60_000L, now, 429));
    }

    @Test
    public void successfulSnapshotClearsActiveCooldownButKeepsRecent429History() {
        Context context = RuntimeEnvironment.getApplication();
        MonitorPrefs.prefs(context).edit()
            .putLong("smartstore_backoff_until", 12345L)
            .putLong("smartstore_backoff_ms", 120_000L)
            .putLong("smartstore_backoff_last_rate_limit_at", 1234L)
            .commit();
        MonitorService.clearRateLimitCooldownOnSuccess(context);
        assertEquals(0L, MonitorPrefs.prefs(context).getLong("smartstore_backoff_until", 0L));
        assertEquals(120_000L, MonitorPrefs.prefs(context).getLong("smartstore_backoff_ms", 0L));
        assertEquals(1234L, MonitorPrefs.prefs(context).getLong("smartstore_backoff_last_rate_limit_at", 0L));
    }

    @Test
    public void smartStoreApiFallbackWaitsForPageStateAndNeverRunsDuring204Recovery() {
        assertFalse(MonitorService.allowSmartStoreApiFallback(0, false, 0L));
        assertFalse(MonitorService.allowSmartStoreApiFallback(1, false, 0L));
        assertTrue(MonitorService.allowSmartStoreApiFallback(2, false, 0L));
        assertFalse(MonitorService.allowSmartStoreApiFallback(2, true, 0L));
        assertFalse(MonitorService.allowSmartStoreApiFallback(2, false, 30_000L));
    }

    @Test
    public void noContentBackoffCoversCorrelatedAndRepeatedSingleProductFailures() {
        assertFalse(MonitorService.shouldStartNoContentBackoff(1, 1, 10_000L));
        assertFalse(MonitorService.shouldStartNoContentBackoff(2, 2, 60_000L));
        assertTrue(MonitorService.shouldStartNoContentBackoff(3, 3, 90_000L));
        assertTrue(MonitorService.shouldStartNoContentBackoff(1, 3, 90_000L));
        assertTrue(MonitorService.shouldStartNoContentBackoff(6, 6, 120_000L));
        assertFalse(MonitorService.shouldStartNoContentBackoff(3, 3, 120_001L));
        assertFalse(MonitorService.shouldStartNoContentBackoff(3, 3, -1L));
    }

    @Test
    public void naverAuthPauseSkipsOnlySmartStoreAndKeepsSwagkeyEligible() throws Exception {
        assertTrue(MonitorService.shouldSkipForNaverSession(SiteSupport.NAVER_SMARTSTORE, false));
        assertFalse(MonitorService.shouldSkipForNaverSession(SiteSupport.NAVER_SMARTSTORE, true));
        assertFalse(MonitorService.shouldSkipForNaverSession(SiteSupport.SWAGKEY_IMWEB, false));

        JSONArray products = new JSONArray()
            .put(new JSONObject()
                .put("url", "https://m.smartstore.naver.com/store/products/123456789")
                .put("siteType", SiteSupport.NAVER_SMARTSTORE))
            .put(new JSONObject()
                .put("url", "https://swagkey.kr/shop_view/?idx=123")
                .put("siteType", SiteSupport.SWAGKEY_IMWEB));

        assertEquals(
            SiteSupport.SWAGKEY_IMWEB,
            MonitorService.firstBootstrapProduct(products, false).optString("siteType")
        );
        assertEquals(
            SiteSupport.NAVER_SMARTSTORE,
            MonitorService.firstBootstrapProduct(products, true).optString("siteType")
        );
    }

    @Test
    public void acceptsOnlyResultsForTheCurrentProduct() throws Exception {
        JSONObject product = new JSONObject()
            .put("id", "123456789")
            .put("url", "https://smartstore.naver.com/store/products/123456789");

        assertTrue(MonitorService.isResultForProduct(
            product, SiteSupport.NAVER_SMARTSTORE,
            new JSONObject().put("productNo", "123456789")
        ));
        assertFalse(MonitorService.isResultForProduct(
            product, SiteSupport.NAVER_SMARTSTORE,
            new JSONObject().put("productNo", "987654321")
        ));
        assertTrue(MonitorService.isResultForProduct(
            product, SiteSupport.NAVER_SMARTSTORE,
            new JSONObject().put("pageUrl", "https://m.smartstore.naver.com/store/products/123456789")
        ));
        assertFalse(MonitorService.isResultForProduct(
            product, SiteSupport.NAVER_SMARTSTORE,
            new JSONObject().put("pageUrl", "https://m.smartstore.naver.com/store/products/987654321")
        ));
    }

    @Test
    public void sameSmartStorePageIsReusedOnlyForTheFirstFreshSnapshot() {
        assertFalse(MonitorService.shouldReloadSmartStorePage("123", "123", 0L));
        assertTrue(MonitorService.shouldReloadSmartStorePage("123", "123", 1L));
        assertTrue(MonitorService.shouldReloadSmartStorePage("123", "456", 0L));
        assertTrue(MonitorService.shouldReloadSmartStorePage("", "123", 0L));
    }

    @Test
    public void inventoryStatusDoesNotSayInStockWhenNothingIsAvailable() {
        assertEquals("재고 없음 0/1 · 10:00:00", MonitorService.inventoryStatusText(0, 1, "10:00:00"));
        assertEquals("재고 있음 1/2 · 10:00:00", MonitorService.inventoryStatusText(1, 2, "10:00:00"));
        assertEquals("재고 있음 2/2 · 10:00:00", MonitorService.inventoryStatusText(2, 2, "10:00:00"));
    }
}
