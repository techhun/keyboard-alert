package com.techhun.keyboardalert.restock;

import static org.junit.Assert.assertEquals;

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
    public void inventoryStatusDoesNotSayInStockWhenNothingIsAvailable() {
        assertEquals("재고 없음 0/1 · 10:00:00", MonitorService.inventoryStatusText(0, 1, "10:00:00"));
        assertEquals("재고 있음 1/2 · 10:00:00", MonitorService.inventoryStatusText(1, 2, "10:00:00"));
        assertEquals("재고 있음 2/2 · 10:00:00", MonitorService.inventoryStatusText(2, 2, "10:00:00"));
    }
}
