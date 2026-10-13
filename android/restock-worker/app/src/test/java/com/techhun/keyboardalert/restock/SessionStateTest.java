package com.techhun.keyboardalert.restock;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SessionStateTest {
    @Test
    public void gateRequiresLoginWhenSessionIsMissingOrServerMarkedExpired() {
        assertTrue(SessionState.shouldShowGate(false, false, false));
        assertTrue(SessionState.shouldShowGate(true, true, false));
        assertFalse(SessionState.shouldShowGate(true, false, false));
    }

    @Test
    public void explicitGuestModeAllowsAppWithoutNaverSession() {
        assertFalse(SessionState.shouldShowGate(false, false, true));
        assertFalse(SessionState.shouldShowGate(false, true, true));
    }
}
