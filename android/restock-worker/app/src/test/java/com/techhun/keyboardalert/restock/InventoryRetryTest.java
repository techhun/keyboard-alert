package com.techhun.keyboardalert.restock;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class InventoryRetryTest {
    @Test public void detectsExplicitAuthFailures() {
        assertTrue(InventoryRetry.isAuthFailure("AUTH_REQUIRED", 200));
        assertTrue(InventoryRetry.isAuthFailure("PRODUCT_API_FAILED", 401));
        assertTrue(InventoryRetry.isAuthFailure("PRODUCT_API_FAILED", 403));
        assertFalse(InventoryRetry.isAuthFailure("PAGE_DATA_NOT_FOUND", 0));
    }

    @Test public void reloadsNoContentOnlyOnce() {
        assertTrue(InventoryRetry.shouldReloadNoContent("NO_CONTENT", 204, 0));
        assertTrue(InventoryRetry.shouldReloadNoContent("NO_CONTENT", 0, 0));
        assertTrue(InventoryRetry.shouldReloadNoContent("UNKNOWN", 204, 0));
        assertFalse(InventoryRetry.shouldReloadNoContent("NO_CONTENT", 204, 1));
        assertFalse(InventoryRetry.shouldReloadNoContent("RATE_LIMITED", 429, 0));
    }

    @Test public void retriesOnlyTransientInteractiveFailures() {
        assertTrue(InventoryRetry.shouldRetryInteractive("PAGE_DATA_NOT_FOUND", 0));
        assertTrue(InventoryRetry.shouldRetryInteractive("STATE_UNKNOWN", 0));
        assertTrue(InventoryRetry.shouldRetryInteractive("PRODUCT_API_FAILED", 500));
        assertFalse(InventoryRetry.shouldRetryInteractive("NO_CONTENT", 204));
        assertFalse(InventoryRetry.shouldRetryInteractive("RATE_LIMITED", 429));
        assertFalse(InventoryRetry.shouldRetryInteractive("UNKNOWN", 404));
    }

    @Test public void monitorRetriesTransientFailuresButNotNoContentOrRateLimit() {
        assertTrue(InventoryRetry.shouldRetryMonitor("PAGE_DATA_NOT_FOUND", 0));
        assertTrue(InventoryRetry.shouldRetryMonitor("JS_ERROR", 0));
        assertTrue(InventoryRetry.shouldRetryMonitor("UNKNOWN", 503));
        assertFalse(InventoryRetry.shouldRetryMonitor("NO_CONTENT", 204));
        assertFalse(InventoryRetry.shouldRetryMonitor("RATE_LIMITED", 429));
        assertFalse(InventoryRetry.shouldRetryMonitor("AUTH_REQUIRED", 200));
    }

    @Test public void directMismatchFallsBackToDiscoveryWithoutTreating204AsRetry() {
        assertTrue(InventoryRetry.shouldRediscoverDirect("API_PRODUCT_MISMATCH", 0));
        assertTrue(InventoryRetry.shouldRediscoverDirect("API_URL_MISSING", 0));
        assertFalse(InventoryRetry.shouldRediscoverDirect("NO_CONTENT", 204));
        assertFalse(InventoryRetry.shouldRediscoverDirect("RATE_LIMITED", 429));
    }
}
