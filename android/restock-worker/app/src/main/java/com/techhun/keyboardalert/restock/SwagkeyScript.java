package com.techhun.keyboardalert.restock;

final class SwagkeyScript {
    private SwagkeyScript() {}

    static final String SCRIPT = """
        (() => {
          const send = (value) => window.RestockBridge.onResult(JSON.stringify(value));
          try {
            const host = (location.hostname || '').toLowerCase();
            if (host !== 'swagkey.kr' && host !== 'www.swagkey.kr') {
              send({ ok: false, error: 'UNTRUSTED_HOST' });
              return 'BLOCKED';
            }

            const textOf = (el) => String(
              el?.innerText || el?.textContent || el?.value || el?.getAttribute?.('aria-label') || ''
            ).replace(/\s+/g, ' ').trim();

            const bodyText = textOf(document.body);
            const title =
              document.querySelector('meta[property="og:title"]')?.content
              || document.querySelector('h1')?.innerText
              || document.querySelector('.shop-title')?.innerText
              || document.title
              || 'SWAGKEY 상품';

            const controls = [...document.querySelectorAll('button, a, input[type="button"], input[type="submit"]')];
            const soldOutControl = controls.find((el) => /품절|sold\s*out/i.test(textOf(el)));
            const buyControl = controls.find((el) =>
              /구매하기|바로\s*구매|buy\s*now|장바구니|cart/i.test(textOf(el))
              && !el.disabled
              && el.getAttribute('aria-disabled') !== 'true'
            );
            const soldOutText = /품절된\s*상품입니다|품절|sold\s*out/i.test(bodyText);

            let available = null;
            if (soldOutControl || /품절된\s*상품입니다/i.test(bodyText)) available = false;
            else if (buyControl) available = true;
            else if (!soldOutText && document.querySelector('[data-product-code], [data-product-no], .shop_view')) available = true;

            if (available === null) {
              send({ ok: false, error: 'STATE_UNKNOWN', title: String(title).trim() });
              return 'UNKNOWN';
            }

            send({
              ok: true,
              title: String(title).replace(/\s+/g, ' ').trim(),
              stockQuantity: available ? null : 0,
              options: [{
                id: 'default',
                optionName1: '기본 상품',
                optionName2: null,
                optionName3: null,
                stockQuantity: available ? null : 0,
                available
              }]
            });
          } catch (error) {
            send({ ok: false, error: 'JS_ERROR', message: String(error) });
          }
          return 'STARTED';
        })()
        """;
}
