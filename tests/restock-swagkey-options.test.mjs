import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

// Execute the exact JavaScript embedded in the production Android WebView.
const source = readFileSync(new URL(
  '../android/restock-worker/app/src/main/java/com/techhun/keyboardalert/restock/SwagkeyScript.java',
  import.meta.url), 'utf8');
const SCRIPT = source.split('static final String SCRIPT = """')[1]
  .split('""";')[0].replaceAll('\\\\', '\\');

function row(label, { soldOut = false, quantity = null, product = 1228,
  malformed = false } = {}) {
  const onclick = soldOut ? 'return false;' : malformed ? 'not-a-product-option()'
    : "SITE_SHOP_DETAIL.selectRequireOption('prod', " + product
      + ",'group','value','" + label + "',function(){})";
  return {
    getAttribute(name) {
      if (name === 'onclick') return onclick;
      if (name === 'aria-disabled') return null;
      return null;
    },
    hasAttribute: () => false,
    querySelector(selector) {
      if (selector === '.margin-bottom-lg') return { textContent: label };
      if (selector === '.option_name') return null;
      if (selector === '.opacity-40') return soldOut ? {} : null;
      if (selector === '.low-stock-nudge-option')
        return quantity === null ? null : { textContent: quantity + '개 남았어요!' };
      return null;
    },
    innerText: label + ' 499,000원' + (soldOut ? ' (품절)' : '')
  };
}

function run(rows, { hasOptionHeader = true, idx = 1228, host = 'www.swagkey.kr',
  noOptionBuy = false } = {}) {
  let result = null;
  const root = hasOptionHeader ? { querySelector: selector =>
    selector === '.option_title' ? {} : null } : null;
  const context = {
    URLSearchParams,
    location: {
      hostname: host, search: '?idx=' + idx, pathname: '/227/',
      href: 'https://' + host + '/227/?idx=' + idx
    },
    document: {
      title: 'SWAGKEY fixture',
      body: { innerText: 'SWAGKEY' },
      querySelector(selector) {
        if (selector === '#prod_options') return root;
        if (selector === 'h1') return { innerText: 'Integral' };
        return null;
      },
      querySelectorAll(selector) {
        if (selector === '#prod_options ._form_select_wrap .dropdown-item > a._requireOption')
          return rows;
        if (selector.startsWith('button, a,') && noOptionBuy)
          return [{ innerText: '구매하기', disabled: false, getAttribute: () => null }];
        return [];
      }
    },
    window: { RestockBridge: { onResult(json) { result = JSON.parse(json); } } }
  };
  vm.runInNewContext(SCRIPT, context);
  return result;
}
const CHAMPAGNE_WK = row('Champagne / WK', {quantity:1});
const CHAMPAGNE_WKL = row('Champagne / WKL', {quantity:3});
const CHAMPAGNE_HHKB = row('Champagne / HHKB');
const SILVER_WK = row('Silver / WK', {soldOut:true});
const SILVER_WKL = row('Silver / WKL', {soldOut:true});
const SILVER_HHKB = row('Silver / HHKB', {soldOut:true});
const BLACK_WKL = row('Black / WKL', {soldOut:true});
const BLACK_HHKB = row('Black / HHKB', {soldOut:true});
const GREY_WK = row('Grey / WK', {quantity:2});
const GREY_HHKB = row('Grey / HHKB', {quantity:1});
const LIVE_FIXTURE = [CHAMPAGNE_WK,CHAMPAGNE_WKL,CHAMPAGNE_HHKB,
  SILVER_WK,SILVER_WKL,SILVER_HHKB,BLACK_WKL,BLACK_HHKB,GREY_WK,GREY_HHKB];

test('JJW Integral: the ten real variant combinations include sold-out options', () => {
  const result = run(LIVE_FIXTURE);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'SWAGKEY_DOM');
  assert.equal(result.options.length, 10);
  const byName = Object.fromEntries(result.options.map(x => [x.optionName1, x]));
  assert.equal(byName['Champagne / WK'].stockQuantity, 1);
  assert.equal(byName['Champagne / WKL'].stockQuantity, 3);
  assert.equal(byName['Champagne / HHKB'].stockQuantity, null);
  assert.equal(byName['Champagne / HHKB'].available, true);
  assert.equal(byName['Grey / WK'].stockQuantity, 2);
  assert.equal(byName['Grey / HHKB'].stockQuantity, 1);
  for (const name of ['Silver / WK','Silver / WKL','Silver / HHKB',
    'Black / WKL','Black / HHKB']) {
    assert.equal(byName[name].available, false, name);
    assert.equal(byName[name].stockQuantity, 0, name);
  }
  assert.equal(byName['Black / WK'], undefined, 'do not invent missing combinations');
  assert.equal(new Set(result.options.map(x=>x.id)).size, 10);
  assert.equal(result.options.some(x=>/선결제|착불/.test(x.optionName1)), false);
});

test('sold-out to available does not change a selection identifier', () => {
  const first = run([row('Silver / WK',{soldOut:true})]);
  const next = run([row('Silver / WK',{quantity:2})]);
  assert.equal(first.options[0].id, next.options[0].id);
  assert.equal(first.options[0].available, false);
  assert.equal(next.options[0].available, true);
});

test('unknown and incomplete option data does not return an invented default', () => {
  const pending = run([]);
  assert.equal(pending.ok, false);
  assert.equal(pending.error, 'STATE_UNKNOWN');
  const malformed = run([row('Grey / WK',{malformed:true})]);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error, 'SWAGKEY_OPTION_DATA_UNVERIFIED');
  const mismatched = run([row('Grey / WK',{product:9999})]);
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.error, 'SWAGKEY_OPTION_DATA_UNVERIFIED');
  const duplicate = run([CHAMPAGNE_WK,CHAMPAGNE_WK]);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error, 'SWAGKEY_OPTION_DATA_UNVERIFIED');
});

test('genuine no-option product preserves the prior single-item fallback', () => {
  const result = run([], {hasOptionHeader:false,noOptionBuy:true});
  assert.equal(result.ok, true);
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].id, 'default');
  assert.equal(result.options[0].available, true);
});

test('rejects untrusted hosts even with a valid product page fixture', () => {
  const result=run(LIVE_FIXTURE,{host:'fake-swagkey.example'});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'UNTRUSTED_HOST');
});
