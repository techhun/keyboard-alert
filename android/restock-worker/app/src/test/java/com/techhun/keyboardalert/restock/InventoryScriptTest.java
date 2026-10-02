package com.techhun.keyboardalert.restock;

import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class InventoryScriptTest {
    @Test
    public void discoveryUsesSavedHintsAndHtmlFallback() throws Exception {
        JSONObject product = new JSONObject();
        product.put("apiUrl", "https://m.smartstore.naver.com/i/v2/channels/savedUid123/products/123456?withWindow=false");
        product.put("channelUid", "savedUid123");
        product.put("productNo", "123456");

        String script = InventoryScript.build(product);

        assertTrue(script.contains("savedUid123"));
        assertTrue(script.contains("123456"));
        assertTrue(script.contains("document.documentElement"));
        assertTrue(script.contains("collectPageRoots"));
        assertTrue(script.contains("__RESTOCK_CAPTURED_RESPONSES__"));
        assertTrue(script.contains("findProductModel"));
        assertTrue(script.contains("optionInfoOf"));
        assertTrue(script.contains("explicitOptionCount"));
        assertTrue(script.contains("productIdentities"));
        assertTrue(script.contains("exactProductMatch"));
        assertTrue(script.contains("document.title.includes(candidateName)"));
        assertTrue(script.contains("PAGE_STATE"));
        assertTrue(script.contains("pageSnapshot.explicitOptionData && pageSnapshot.options.length > 0"));
        assertTrue(script.contains("if (!options.length && allowSyntheticDefault)"));
        assertTrue(script.contains("'PAGE_STATE',"));
        assertTrue(script.contains("pageModel.exact,"));
        assertTrue(script.contains("snapshot(data, productNo, channelUid, apiUrl, 'API', true, true)"));
        assertTrue(script.contains("PAGE_DATA_NOT_FOUND"));
        assertTrue(script.contains("AUTH_REQUIRED"));
        assertTrue(script.contains("RATE_LIMITED"));
        assertTrue(script.contains("response.status === 204 || response.status === 429"));
        assertTrue(InventoryScript.build(product, false).contains("const allowApiFallback = false;"));
        assertTrue(script.contains("API_DEFERRED"));
    }

    @Test
    public void directLookupClassifiesAuthenticationFailure() throws Exception {
        JSONObject product = new JSONObject();
        product.put("id", "sample");
        product.put("apiUrl", "https://m.smartstore.naver.com/i/v2/channels/savedUid123/products/123456?withWindow=false");

        String script = InventoryApiScript.build(product);

        assertTrue(script.contains("AUTH_REQUIRED"));
        assertTrue(script.contains("PRODUCT_DATA_NOT_FOUND"));
        assertTrue(script.contains("RATE_LIMITED"));
        assertTrue(script.contains("response.status === 204 || response.status === 429"));
        assertTrue(script.contains("nid.naver.com"));
    }
}
