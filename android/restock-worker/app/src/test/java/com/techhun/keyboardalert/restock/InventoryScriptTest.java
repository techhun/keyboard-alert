package com.techhun.keyboardalert.restock;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public class InventoryScriptTest {
    @Test
    public void buildInjectsSavedChannelUidAsFallback() throws Exception {
        JSONObject product = new JSONObject();
        product.put("channelUid", "saved-channel-uid");

        String script = InventoryScript.build(product);

        assertTrue(script.contains("const configuredChannelUid = \"saved-channel-uid\";"));
        assertFalse(script.contains("__RESTOCK_CONFIGURED_CHANNEL_UID__"));
    }

    @Test
    public void buildRecoversChannelUidFromSavedApiUrl() throws Exception {
        JSONObject product = new JSONObject();
        product.put(
            "apiUrl",
            "https://smartstore.naver.com/i/v2/channels/recovered-channel-uid/products/123456789?withWindow=false"
        );

        String script = InventoryScript.build(product);

        assertTrue(script.contains("const configuredChannelUid = \"recovered-channel-uid\";"));
    }

    @Test
    public void defaultScriptKeepsFallbackEmptyForInteractiveLookup() {
        assertTrue(InventoryScript.SCRIPT.contains("const configuredChannelUid = '';"));
    }

    @Test
    public void interactiveLookupDoesNotTreatGenericLoginLinksAsExpiredSession() {
        assertFalse(InventoryScript.SCRIPT.contains("pageNeedsLogin"));
        assertTrue(InventoryScript.SCRIPT.contains("responseNeedsLogin"));
        assertTrue(InventoryScript.SCRIPT.contains("error: 'CHANNEL_UID_NOT_FOUND'"));
    }
}
