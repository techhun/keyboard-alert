package com.techhun.keyboardalert.restock;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SessionStateTest {
    @Test
    public void rateLimitedOptionLookupIsNotMisclassifiedAsLoginExpired() {
        assertFalse(SessionState.isInventoryAuthenticationFailure(
            "RATE_LIMITED", 429, false, false));
        assertFalse(SessionState.isInventoryAuthenticationFailure(
            "RATE_LIMITED", 0, false, true));
        assertFalse(SessionState.isInventoryAuthenticationFailure(
            "UNKNOWN", 429, false, false));
        assertTrue(SessionState.isInventoryAuthenticationFailure(
            "AUTH_REQUIRED", 0, false, true));
        assertTrue(SessionState.isInventoryAuthenticationFailure(
            "UNKNOWN", 401, false, true));
        assertTrue(SessionState.isInventoryAuthenticationFailure(
            "UNKNOWN", 403, false, true));
        assertTrue(SessionState.isInventoryAuthenticationFailure(
            "UNKNOWN", 0, true, true));
        assertTrue(SessionState.isInventoryAuthenticationFailure(
            "UNKNOWN", 0, false, false));
        assertFalse(SessionState.isInventoryAuthenticationFailure(
            "UNKNOWN", 0, false, true));
    }

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
