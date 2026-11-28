package com.techhun.keyboardalert.restock;

import static org.junit.Assert.assertEquals;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public class OptionLabelTest {
    private static JSONObject option(String first, String second, String third) throws Exception {
        JSONObject option = new JSONObject();
        option.put("id", "option-1");
        if (first != null) option.put("optionName1", first);
        if (second != null) option.put("optionName2", second);
        if (third != null) option.put("optionName3", third);
        return option;
    }

    @Test
    public void dropsSmartStoreAgreementBoilerplate() throws Exception {
        assertEquals("민트 WK / A Grade",
            MainActivity.optionLabel(option("동의합니다.", "민트 WK", "A Grade")));
    }

    @Test
    public void dropsDuplicateSegments() throws Exception {
        assertEquals("CEM3 코어리스(RAW) / F12",
            MainActivity.optionLabel(option("CEM3 코어리스(RAW)", "CEM3 코어리스(RAW)", "F12")));
    }

    @Test
    public void cleansStoredLabels() {
        assertEquals("민트 WK / A Grade",
            MainActivity.cleanOptionLabel("동의합니다. / 민트 WK / [필수] / A Grade"));
    }

    @Test
    public void fallsBackToIdWhenEverySegmentIsNoise() throws Exception {
        assertEquals("option-1", MainActivity.optionLabel(option("동의합니다.", "선택", null)));
    }
}
