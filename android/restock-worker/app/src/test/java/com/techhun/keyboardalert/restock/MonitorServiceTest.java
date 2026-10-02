package com.techhun.keyboardalert.restock;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class MonitorServiceTest {
    @Test
    public void productSpacingKeepsFiveSecondSafetyFloor() {
        assertEquals(5_000L, MonitorService.productSpacingMillis(15, 7));
        assertEquals(15_000L, MonitorService.productSpacingMillis(15, 1));
        assertEquals(30_000L, MonitorService.productSpacingMillis(60, 2));
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
    public void inventoryStatusDoesNotSayInStockWhenNothingIsAvailable() {
        assertEquals("재고 없음 0/1 · 10:00:00", MonitorService.inventoryStatusText(0, 1, "10:00:00"));
        assertEquals("재고 있음 1/2 · 10:00:00", MonitorService.inventoryStatusText(1, 2, "10:00:00"));
        assertEquals("재고 있음 2/2 · 10:00:00", MonitorService.inventoryStatusText(2, 2, "10:00:00"));
    }
}
