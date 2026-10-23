package com.techhun.keyboardalert.restock;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

@RunWith(RobolectricTestRunner.class)
public class ProductStoreTest {
    private Context context;

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        MonitorPrefs.prefs(context).edit().clear().commit();
    }

    @Test
    public void resetLowStockStatePreservesAvailabilityAndProductState() throws Exception {
        JSONObject product = new JSONObject();
        product.put("id", "123");
        product.put("url", "https://smartstore.naver.com/example/products/123");
        product.put("enabled", true);
        product.put("lastAvailability", new JSONObject().put("option-1", true));
        product.put("lastStockQuantity", new JSONObject().put("option-1", 4));
        product.put("lowStockAfterRestock", new JSONObject().put("option-1", 3));

        ProductStore.save(context, new JSONArray().put(product));
        ProductStore.resetLowStockState(context);

        JSONObject restored = ProductStore.find(context, "123");
        assertTrue(restored.optBoolean("enabled", false));
        assertTrue(restored.optJSONObject("lastAvailability").optBoolean("option-1", false));
        assertEquals(0, restored.optJSONObject("lastStockQuantity").length());
        assertEquals(0, restored.optJSONObject("lowStockAfterRestock").length());
    }

    @Test
    public void failedAttemptPreservesSuccessfulSnapshotTimeAndStock() throws Exception {
        JSONObject product = new JSONObject()
            .put("id", "123")
            .put("url", "https://smartstore.naver.com/example/products/123")
            .put("lastAvailability", new JSONObject().put("option-1", true))
            .put("lastStockQuantity", new JSONObject().put("option-1", 1))
            .put("lastSuccess", 1000L)
            .put("lastCheck", 1000L);
        ProductStore.save(context, new JSONArray().put(product));
        JSONObject failed = ProductStore.find(context, "123");
        failed.put("lastCheck", 2000L);
        failed.put("lastStatus", "조회 실패");
        ProductStore.updateRuntime(context, failed);
        JSONObject stored = ProductStore.find(context, "123");
        assertEquals(1000L, stored.optLong("lastSuccess"));
        assertEquals(2000L, stored.optLong("lastCheck"));
        assertEquals(1, stored.optJSONObject("lastStockQuantity").optInt("option-1"));
        assertTrue(stored.optJSONObject("lastAvailability").optBoolean("option-1"));
    }

    @Test
    public void tenSecondIntervalPersistsAndRestoresFromBackup() throws Exception {
        MonitorPrefs.prefs(context).edit().putInt(MonitorPrefs.KEY_INTERVAL, 10).commit();
        assertEquals(10, MonitorPrefs.intervalSeconds(context));
        String backup = ProductStore.exportBackup(context);
        MonitorPrefs.prefs(context).edit().putInt(MonitorPrefs.KEY_INTERVAL, 15).commit();
        ProductStore.importBackup(context, backup);
        assertEquals(10, MonitorPrefs.intervalSeconds(context));
        JSONObject invalid = new JSONObject(backup).put("intervalSeconds", 5);
        ProductStore.importBackup(context, invalid.toString());
        assertEquals(30, MonitorPrefs.intervalSeconds(context));
    }

    @Test
    public void backupRestoresLowStockThresholdAndDefaultsOldBackupsToFive() throws Exception {
        MonitorPrefs.prefs(context).edit().putInt(MonitorPrefs.KEY_LOW_STOCK_THRESHOLD, 7).commit();
        JSONObject product = new JSONObject()
            .put("id", "123")
            .put("url", "https://smartstore.naver.com/example/products/123")
            .put("title", "Test")
            .put("selectedIds", new JSONArray().put("default"))
            .put("selectedLabels", new JSONObject().put("default", "기본 상품"))
            .put("siteType", SiteSupport.NAVER_SMARTSTORE)
            .put("enabled", false);
        ProductStore.save(context, new JSONArray().put(product));

        String backup = ProductStore.exportBackup(context);
        MonitorPrefs.prefs(context).edit().putInt(MonitorPrefs.KEY_LOW_STOCK_THRESHOLD, 2).commit();
        ProductStore.importBackup(context, backup);
        assertEquals(7, MonitorPrefs.lowStockThreshold(context));

        JSONObject oldBackup = new JSONObject(backup);
        oldBackup.remove("lowStockThreshold");
        ProductStore.importBackup(context, oldBackup.toString());
        assertEquals(5, MonitorPrefs.lowStockThreshold(context));
    }
}
