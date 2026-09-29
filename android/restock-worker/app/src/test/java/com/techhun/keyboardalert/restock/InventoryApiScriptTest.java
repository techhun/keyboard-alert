package com.techhun.keyboardalert.restock;

import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public class InventoryApiScriptTest {
    @Test
    public void buildRejectsCachedApiForAnotherProduct() throws Exception {
        JSONObject product = new JSONObject();
        product.put("id", "123456789");
        product.put("apiUrl", "https://smartstore.naver.com/i/v2/channels/test/products/987654321?withWindow=false");
        product.put("title", "Galatea");

        String script = InventoryApiScript.build(product);

        assertTrue(script.contains("API_PRODUCT_MISMATCH"));
        assertTrue(script.contains("123456789"));
        assertTrue(script.contains("987654321"));
    }
}
