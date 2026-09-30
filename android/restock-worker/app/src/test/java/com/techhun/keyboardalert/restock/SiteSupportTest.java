package com.techhun.keyboardalert.restock;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class SiteSupportTest {
    @Test
    public void detectsSupportedProductUrls() {
        assertEquals(
            SiteSupport.NAVER_SMARTSTORE,
            SiteSupport.detect("https://smartstore.naver.com/swagkey/products/123456789")
        );
        assertEquals(
            SiteSupport.NAVER_SMARTSTORE,
            SiteSupport.detect("https://m.smartstore.naver.com/swagkey/products/123456789")
        );
        assertEquals(
            SiteSupport.SWAGKEY_IMWEB,
            SiteSupport.detect("https://swagkey.kr/?idx=123")
        );
        assertEquals(
            SiteSupport.SWAGKEY_IMWEB,
            SiteSupport.detect("https://www.swagkey.kr/shop_view/123")
        );
    }

    @Test
    public void rejectsUnsupportedOrSpoofedUrls() {
        assertEquals(
            SiteSupport.UNKNOWN,
            SiteSupport.detect("http://smartstore.naver.com/swagkey/products/123")
        );
        assertEquals(
            SiteSupport.UNKNOWN,
            SiteSupport.detect("https://smartstore.naver.com.example.com/swagkey/products/123")
        );
        assertEquals(
            SiteSupport.UNKNOWN,
            SiteSupport.detect("https://evil.example/?next=https://swagkey.kr/?idx=123")
        );
        assertEquals(
            SiteSupport.UNKNOWN,
            SiteSupport.detect("https://swagkey.kr/")
        );
    }

    @Test
    public void allowsOnlyPagesInsideSelectedSite() {
        assertTrue(
            SiteSupport.isAllowedPage(
                SiteSupport.NAVER_SMARTSTORE,
                "https://m.smartstore.naver.com/swagkey/products/123"
            )
        );
        assertFalse(
            SiteSupport.isAllowedPage(
                SiteSupport.NAVER_SMARTSTORE,
                "https://swagkey.kr/?idx=123"
            )
        );
        assertTrue(
            SiteSupport.isAllowedPage(
                SiteSupport.SWAGKEY_IMWEB,
                "https://www.swagkey.kr/shop_view/123"
            )
        );
        assertFalse(
            SiteSupport.isAllowedPage(
                SiteSupport.SWAGKEY_IMWEB,
                "https://swagkey.kr.example.com/shop_view/123"
            )
        );
    }

    @Test
    public void extractsStableProductIds() {
        assertEquals(
            "123456789",
            SiteSupport.productId("https://smartstore.naver.com/swagkey/products/123456789")
        );
        assertEquals(
            "swagkey-321",
            SiteSupport.productId("https://swagkey.kr/?idx=321")
        );
        assertEquals(
            "swagkey-654",
            SiteSupport.productId("https://www.swagkey.kr/shop_view/654")
        );
    }

    @Test
    public void matchesOnlyTheExactConfiguredProductPage() {
        assertTrue(SiteSupport.isSameProductPage(
            SiteSupport.NAVER_SMARTSTORE,
            "https://smartstore.naver.com/store/products/123456789",
            "https://m.smartstore.naver.com/store/products/123456789?NaPm=1"
        ));
        assertFalse(SiteSupport.isSameProductPage(
            SiteSupport.NAVER_SMARTSTORE,
            "https://smartstore.naver.com/store/products/123456789",
            "https://smartstore.naver.com/store/products/987654321"
        ));
        assertTrue(SiteSupport.isSameProductPage(
            SiteSupport.SWAGKEY_IMWEB,
            "https://swagkey.kr/?idx=321",
            "https://www.swagkey.kr/shop_view/321"
        ));
        assertFalse(SiteSupport.isSameProductPage(
            SiteSupport.SWAGKEY_IMWEB,
            "https://swagkey.kr/?idx=321",
            "https://swagkey.kr/?idx=654"
        ));
    }

    @Test
    public void detectsNaverLoginOnlyOnNaverIdentityHost() {
        assertTrue(SiteSupport.isNaverLoginUrl("https://nid.naver.com/nidlogin.login"));
        assertFalse(SiteSupport.isNaverLoginUrl("https://nid.naver.com.example.com/nidlogin.login"));
    }
}
