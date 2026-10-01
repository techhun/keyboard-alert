package com.techhun.keyboardalert.restock;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class OptionSelectionResolverTest {
    @Test
    public void keepsExactIdsWhenTheyStillMatch() throws Exception {
        JSONArray ids = new JSONArray().put("old-1");
        JSONObject labels = new JSONObject().put("old-1", "Black / ANSI");
        JSONArray options = new JSONArray().put(option("old-1", "Black", "ANSI", true));

        OptionSelectionResolver.Resolution result = OptionSelectionResolver.resolve(ids, labels, options);

        assertTrue(result.complete());
        assertEquals(0, result.migratedCount);
        assertTrue(result.availability.get("old-1"));
    }

    @Test
    public void migratesChangedIdUsingUniqueNormalizedLabel() throws Exception {
        JSONArray ids = new JSONArray().put("api-id");
        JSONObject labels = new JSONObject().put("api-id", "Black / ANSI");
        JSONArray options = new JSONArray().put(option("page-id", "Black", "ANSI", false));

        OptionSelectionResolver.Resolution result = OptionSelectionResolver.resolve(ids, labels, options);

        assertTrue(result.complete());
        assertEquals(1, result.migratedCount);
        assertEquals("page-id", result.selectedIds.getString(0));
        assertFalse(result.availability.get("page-id"));
    }

    @Test
    public void refusesAmbiguousLabels() throws Exception {
        JSONArray ids = new JSONArray().put("api-id");
        JSONObject labels = new JSONObject().put("api-id", "Black / ANSI");
        JSONArray options = new JSONArray()
            .put(option("page-1", "Black", "ANSI", true))
            .put(option("page-2", "Black", "ANSI", false));

        OptionSelectionResolver.Resolution result = OptionSelectionResolver.resolve(ids, labels, options);

        assertFalse(result.complete());
        assertEquals(0, result.availability.size());
    }

    private JSONObject option(String id, String first, String second, boolean available) throws Exception {
        return new JSONObject()
            .put("id", id)
            .put("optionName1", first)
            .put("optionName2", second)
            .put("available", available);
    }
}
