package com.techhun.keyboardalert.restock;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class LowStockAlertTest {
    @Test public void alertsOnceWhenStockFallsBelowThreshold() {
        assertTrue(LowStockAlert.shouldNotify(6, 5, 5, false));
        assertFalse(LowStockAlert.shouldNotify(5, 4, 5, false));
        assertFalse(LowStockAlert.shouldNotify(4, 4, 5, false));
        assertTrue(LowStockAlert.shouldNotify(8, 3, 5, false));
    }

    @Test public void alertsOnFirstLowSnapshotButNotUnknownOrSoldOut() {
        assertTrue(LowStockAlert.shouldNotify(null, 2, 5, false));
        assertFalse(LowStockAlert.shouldNotify(null, 0, 5, false));
        assertFalse(LowStockAlert.shouldNotify(null, 6, 5, false));
    }

    @Test public void restockTakesPrecedenceAndRearmsAfterRecovery() {
        assertFalse(LowStockAlert.shouldNotify(0, 3, 5, true));
        assertFalse(LowStockAlert.shouldNotify(3, 0, 5, false));
        assertTrue(LowStockAlert.shouldNotify(0, 2, 5, false));
        assertFalse(LowStockAlert.shouldNotify(2, 4, 5, false));
        assertTrue(LowStockAlert.shouldNotify(7, 4, 5, false));
    }
}
