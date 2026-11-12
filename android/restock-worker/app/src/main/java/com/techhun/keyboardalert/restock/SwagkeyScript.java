package com.techhun.keyboardalert.restock;

final class SwagkeyScript {
    private SwagkeyScript() {}

    static final String SCRIPT = """
        (() => {
          const send = (value) => window.RestockBridge.onResult(JSON.stringify(value));
          try {
            const host = (location.hostname || '').toLowerCase();
            if (host !== 'swagkey.kr' && host !== 'www.swagkey.kr') {
              send({ ok: false, error: 'UNTRUSTED_HOST', pageUrl: location.href });
              return 'BLOCKED';
            }

            const textOf = (el) => String(
              el?.innerText || el?.textContent || el?.value || el?.getAttribute?.('aria-label') || ''
            ).replace(/\\s+/g, ' ').trim();
            const cleanTitle = (value) => String(value || '')
              .replace(/\\s+/g, ' ')
              .replace(/\\s*[:|-]\\s*스웨그키\\s*공식\\s*온라인\\s*스토어\\s*$/i, '')
              .trim();
            const title =
              cleanTitle(document.querySelector('h1')?.innerText)
              || cleanTitle(document.querySelector('.shop-title')?.innerText)
              || cleanTitle(document.querySelector('meta[property="og:title"]')?.content)
              || cleanTitle(document.title)
              || 'SWAGKEY 상품';

            // Imweb exposes real option combinations under the PRODUCT option
            // block. Never mix these with the adjacent delivery-payment dropdown.
            const root = document.querySelector('#prod_options');
            const rows = [...document.querySelectorAll(
              '#prod_options ._form_select_wrap .dropdown-item > a._requireOption'
            )];
            if (rows.length > 0) {
              // Product option pages can have unavailable combinations which do
              // not include a server option ID. A stable label-derived ID keeps
              // selections unchanged when a sold-out option becomes available.
              const urlIdx = new URLSearchParams(location.search || '').get('idx')
                || (location.pathname.match(/\\/shop_view\\/(\\d+)/) || [])[1] || '';
              if (!/^\\d+$/.test(urlIdx) || rows.length > 200) {
                send({ ok: false, error: 'SWAGKEY_OPTION_DATA_UNVERIFIED', title,
                  pageUrl: location.href });
                return 'UNVERIFIED';
              }

              const options = [];
              const seen = new Set();
              for (const row of rows) {
                const label = textOf(row.querySelector('.margin-bottom-lg')
                  || row.querySelector('.option_name'));
                const raw = textOf(row);
                const onclick = row.getAttribute('onclick') || '';
                const soldOut = /\\(품절\\)|품절|sold\\s*out/i.test(raw)
                  || /return\\s+false\\s*;?/.test(onclick)
                  || row.getAttribute('aria-disabled') === 'true'
                  || row.hasAttribute('disabled')
                  || !!row.querySelector('.opacity-40');
                const call = onclick.match(
                  /SITE_SHOP_DETAIL\\.selectRequireOption\\(\\s*['"]prod['"]\\s*,\\s*(\\d+)\\s*,/
                );
                const selectable = !!call && call[1] === urlIdx;
                if (!label || seen.has(label) || (!soldOut && !selectable)) {
                  send({ ok: false, error: 'SWAGKEY_OPTION_DATA_UNVERIFIED', title,
                    pageUrl: location.href });
                  return 'UNVERIFIED';
                }
                seen.add(label);

                const badge = textOf(row.querySelector('.low-stock-nudge-option'));
                const match = badge.match(/([\\d,]+)\\s*개\\s*남았어요/);
                const quantity = match ? Number(match[1].replace(/,/g, ''))
                  : (soldOut ? 0 : null);
                const available = !soldOut && selectable && (quantity === null || quantity > 0);
                options.push({
                  id: 'imweb:' + label.normalize('NFKC'),
                  optionName1: label,
                  optionName2: null,
                  optionName3: null,
                  stockQuantity: quantity,
                  available
                });
              }

              send({ ok: true, title, pageUrl: location.href,
                source: 'SWAGKEY_DOM', options });
              return 'OPTIONS';
            }

            // An option heading with no rows means JS has not populated the
            // product options yet (or uses an unknown layout). Do not fabricate
            // a single default option and accidentally report a restock.
            if (root && root.querySelector('.option_title')) {
              send({ ok: false, error: 'STATE_UNKNOWN', title, pageUrl: location.href });
              return 'OPTIONS_PENDING';
            }

            // Preserve the existing behavior for genuine no-option products.
            const controls = [...document.querySelectorAll('button, a, input[type="button"], input[type="submit"]')];
            const soldOutControl = controls.find((el) => /품절|sold\\s*out/i.test(textOf(el)));
            const buyControl = controls.find((el) =>
              /구매하기|바로\\s*구매|buy\\s*now|장바구니|cart/i.test(textOf(el))
              && !el.disabled
              && el.getAttribute('aria-disabled') !== 'true'
            );
            const bodyText = textOf(document.body);
            const unavailableText = /품절된\\s*상품입니다|판매\\s*기간이\\s*마감된\\s*상품입니다|판매대기|sold\\s*out/i.test(bodyText);
            const genericSoldOutText = /품절|sold\\s*out/i.test(bodyText);

            let available = null;
            if (soldOutControl || unavailableText) available = false;
            else if (buyControl) available = true;
            else if (!genericSoldOutText && document.querySelector('[data-product-code], [data-product-no], .shop_view')) available = true;

            if (available === null) {
              send({ ok: false, error: 'STATE_UNKNOWN', title, pageUrl: location.href });
              return 'UNKNOWN';
            }

            send({
              ok: true,
              pageUrl: location.href,
              title,
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
            send({ ok: false, error: 'JS_ERROR', message: String(error), pageUrl: location.href });
          }
          return 'STARTED';
        })()
        """;
}
