import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright';

const source = readFileSync(new URL(
  '../android/restock-worker/app/src/main/java/com/techhun/keyboardalert/restock/SwagkeyScript.java',
  import.meta.url), 'utf8');
const script = source.split('static final String SCRIPT = """')[1]
  .split('""";')[0].replaceAll('\\\\', '\\');
const legacy = readFileSync(new URL('./fixtures/restock-swagkey-1228-20261113.html', import.meta.url), 'utf8');
const capturedV2 = readFileSync(new URL('./fixtures/restock-swagkey-1228-v2-20261128.html', import.meta.url), 'utf8');
const url = 'https://www.swagkey.kr/227/?idx=1228';
let browser;
before(async () => {
  const channel = process.env.RESTOCK_BROWSER_CHANNEL;
  browser = await chromium.launch(channel ? { channel } : {});
});
after(async () => { await browser?.close(); });

// No network requests to a real shop: the browser receives only a local fixture.
// Unlike the row mocks, Chromium itself evaluates selectors and DOM ancestry.
async function parse(html) {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.request().url() === url
      ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
      : route.abort());
    await page.goto(url);
    return await page.evaluate(code => {
      let value;
      window.RestockBridge = { onResult: json => { value = JSON.parse(json); } };
      (0, eval)(code);
      return value;
    }, script);
  } finally {
    await page.close();
  }
}

// Reconstructed from Pickle's 2026-11-28 runtime DOM report, NOT a verbatim
// capture. V2 puts onclick on div.tabled, label span has no old class, and
// the quantity badge is outside the anchor but within the dropdown-item.
const variants = [
  ['Champagne / WK', false, null], ['Champagne / WKL', true, 3],
  ['Champagne / HHKB', true, null], ['Silver / WK', false, null],
  ['Silver / WKL', false, null], ['Silver / HHKB', false, null],
  ['Black / WKL', false, null], ['Black / HHKB', true, 1],
  ['Grey / WK', true, 2], ['Grey / HHKB', false, null]
];
function row(name, available, quantity, product = 1228) {
  const click = available ? "SITE_SHOP_DETAIL.selectRequireOption('prod', " + product
    + ",'group','value','" + name + "',function(){})" : 'return false;';
  const badge = quantity === null ? '' : '<div><span class="low-stock-nudge-option">'
    + quantity + '개 남았어요!</span></div>';
  return '<div class="dropdown-item"><div class="tabled" onclick="' + click + '">'
    + '<div class="table-cell"><a class="_requireOption blocked"><span>' + name
    + '</span><span class="no-margin"><strong>499,000원'
    + (available ? '' : ' (품절)') + '</strong></span></a></div></div>' + badge + '</div>';
}
const wrap = rows => '<h1>Integral</h1><div id="prod_options"><div class="option_title">옵션</div>'
  + '<div class="_form_select_wrap">' + rows + '</div></div>'
  + '<div class="_form_select_wrap"><div class="dropdown-item"><a class="_requireOption">착불</a></div></div>';

test('actual legacy captured HTML: ten options, stable identifiers and stock', async () => {
  const result = await parse(legacy);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'SWAGKEY_DOM');
  assert.equal(result.options.length, 10);
  assert.equal(result.options.filter(x => !x.available).length, 5);
  assert.equal(result.options.find(x => x.id === 'imweb:Champagne / WKL').stockQuantity, 3);
  assert.equal(result.options.find(x => x.id === 'imweb:Champagne / HHKB').stockQuantity, null);
});

test('V2 reported DOM layout: four available, six sold out and three low-stock badges', async () => {
  const result = await parse(wrap(variants.map(v => row(...v)).join('')));
  assert.equal(result.ok, true);
  assert.equal(result.source, 'SWAGKEY_DOM');
  assert.equal(result.options.length, 10);
  assert.deepEqual(result.options.map(x => [x.optionName1,x.available,x.stockQuantity]),
    variants.map(([name,available,qty]) => [name,available,available ? qty : 0]));
  assert.deepEqual(result.options.map(x => x.id), variants.map(([name]) => 'imweb:' + name));
  assert.equal(result.options.some(x => /선결제|착불/.test(x.optionName1)), false);
});

test('actual 2026-11-28 captured V2 DOM: all ten options and stable IDs', async () => {
  const result = await parse(capturedV2);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'SWAGKEY_DOM');
  assert.equal(result.options.length, 10);
  assert.deepEqual(result.options.map(x => [x.id, x.optionName1, x.available, x.stockQuantity]),
    variants.map(([name, available, qty]) => ['imweb:' + name, name, available, available ? qty : 0]));
});

test('V2 rejects foreign product and unverified click handlers; no default fallback', async () => {
  const foreign = await parse(wrap(row('Grey / WK', true, 2, 9999)));
  assert.equal(foreign.error, 'SWAGKEY_OPTION_DATA_UNVERIFIED');
  const malformed = await parse(wrap(row('Grey / WK', true, 2)
    .replace(/onclick="[^"]*"/, 'onclick="not-a-product-option()"')));
  assert.equal(malformed.error, 'SWAGKEY_OPTION_DATA_UNVERIFIED');
  const pending = await parse(wrap(''));
  assert.equal(pending.error, 'STATE_UNKNOWN');
});

test('V2 stock transitions keep existing option IDs; sold-out stale badge is zero', async () => {
  const soldOut = await parse(wrap(row('Black / HHKB', false, 2)));
  const inStock = await parse(wrap(row('Black / HHKB', true, 1)));
  assert.equal(soldOut.options[0].id, inStock.options[0].id);
  assert.equal(soldOut.options[0].stockQuantity, 0);
  assert.equal(soldOut.options[0].available, false);
  assert.equal(inStock.options[0].available, true);
  assert.equal(inStock.options[0].stockQuantity, 1);
});

test('genuine no-option product still has one default option', async () => {
  const result = await parse('<h1>상품</h1><button>구매하기</button>');
  assert.equal(result.ok, true);
  assert.equal(result.options[0].id, 'default');
});
