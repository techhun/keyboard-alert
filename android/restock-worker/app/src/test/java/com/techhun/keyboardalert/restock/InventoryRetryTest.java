package com.techhun.keyboardalert.restock;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class InventoryRetryTest {
    @Test
    public void rediscoverDirectIncludesIncompleteSuccessfulPayload() {
        assertTrue(InventoryRetry.shouldRediscoverDirect("PRODUCT_DATA_NOT_FOUND", 200));
        assertTrue(InventoryRetry.shouldRediscoverDirect("PRODUCT_API_FAILED", 500));
        assertTrue(InventoryRetry.shouldRediscoverDirect("API_URL_MISSING", 0));
        assertTrue(InventoryRetry.shouldRediscoverDirect("API_PRODUCT_MISMATCH", 0));
        assertTrue(InventoryRetry.shouldRediscoverDirect("JS_ERROR", 0));
        assertTrue(InventoryRetry.shouldRediscoverDirect("UNKNOWN", 204));
        assertTrue(InventoryRetry.shouldRediscoverDirect("UNKNOWN", 404));
        assertFalse(InventoryRetry.shouldRediscoverDirect("UNKNOWN", 200));
        assertFalse(InventoryRetry.shouldRediscoverDirect("STATE_UNKNOWN", 0));
    }

    @Test
    public void retriesTransientDiscoveryErrors() {
        assertTrue(InventoryRetry.shouldRetry("CHANNEL_UID_NOT_FOUND", 0));
        assertTrue(InventoryRetry.shouldRetry("PRODUCT_DATA_NOT_FOUND", 200));
        assertTrue(InventoryRetry.shouldRetry("PRODUCT_API_FAILED", 0));
        assertTrue(InventoryRetry.shouldRetry("STATE_UNKNOWN", 0));
        assertTrue(InventoryRetry.shouldRetry("JS_ERROR", 0));
        assertTrue(InventoryRetry.shouldRetry("PRODUCT_API_FAILED", 500));
        assertTrue(InventoryRetry.shouldRetry("UNKNOWN", 503));
        assertTrue(InventoryRetry.shouldRetry("UNKNOWN", 408));
    }

    @Test
    public void doesNotRetryAuthRateLimitOrValidationFailures() {
        assertFalse(InventoryRetry.shouldRetry("PRODUCT_API_FAILED", 401));
        assertFalse(InventoryRetry.shouldRetry("PRODUCT_API_FAILED", 403));
        assertFalse(InventoryRetry.shouldRetry("PRODUCT_API_FAILED", 429));
        assertFalse(InventoryRetry.shouldRetry("PRODUCT_NO_NOT_FOUND", 0));
        assertFalse(InventoryRetry.shouldRetry("UNKNOWN", 404));
    }
}
