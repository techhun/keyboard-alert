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
}
