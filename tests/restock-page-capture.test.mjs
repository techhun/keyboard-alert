import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const source = readFileSync(new URL('../android/restock-worker/app/src/main/java/com/techhun/keyboardalert/restock/SmartStorePageCapture.java', import.meta.url), 'utf8');
const script = source.split('static final String SCRIPT = """')[1].split('""";')[0].replaceAll('\\\\', '\\');
const url = 'https://m.smartstore.naver.com/i/v2/channels/test/products/123456';
function setup(fetch) {
  class Xhr { open() {} send() {} }
  let clock = 10;
  const context = { URL, location: { href: url }, performance: { now: () => ++clock }, window: { fetch, addEventListener: (name, callback) => { context.errorListener = callback; } }, XMLHttpRequest: Xhr };
  vm.runInNewContext(script, context);
  return context;
}
test('records pending request before response and completes 204 without stock data', async () => {
  let resolve;
  const context = setup(() => new Promise(r => { resolve = r; }));
  const pending = context.window.fetch(url);
  const trace = context.window.__RESTOCK_CAPTURE_TRACE__;
  assert.equal(trace.requests.length, 1);
  assert.equal(trace.requests[0].done, false);
  resolve({ url, status: 204, clone: () => ({ json: async () => { throw Error('empty'); } }) });
  await pending;
  await new Promise(r => setImmediate(r));
  assert.equal(trace.requests[0].done, true);
  assert.equal(context.window.__RESTOCK_PRODUCT_OUTCOMES__.at(-1).kind, 'not-json');
  assert.equal(context.window.__RESTOCK_PRODUCT_OUTCOMES__.at(-1).status, 204);
  assert.equal(context.window.__RESTOCK_CAPTURED_RESPONSES__.length, 0);
});
test('network failure ends pending state without retaining error body', async () => {
  const context = setup(async () => { throw Error('private failure body'); });
  await assert.rejects(context.window.fetch(url));
  assert.equal(context.window.__RESTOCK_CAPTURE_TRACE__.requests[0].done, true);
  assert.equal(context.window.__RESTOCK_PRODUCT_OUTCOMES__[0].kind, 'network-error');
  assert.equal(JSON.stringify(context.window.__RESTOCK_PRODUCT_OUTCOMES__).includes('private'), false);
});
test('does not trace login or unrelated requests', async () => {
  const context = setup(async u => ({ url: u, status: 200, clone: () => ({ json: async () => ({}) }) }));
  await context.window.fetch('https://nid.naver.com/login');
  await context.window.fetch('https://m.smartstore.naver.com/unrelated');
  assert.equal(context.window.__RESTOCK_CAPTURE_TRACE__.requests.length, 0);
});
test('detects replaced fetch hook even though installed flag remains true', () => {
  const context = setup(async () => ({}));
  assert.equal(context.window.fetch, context.window.__RESTOCK_CAPTURE_TRACE__.fetchHook);
  context.window.fetch = async () => ({});
  assert.equal(context.window.__RESTOCK_CAPTURE_INSTALLED__, true);
  assert.notEqual(context.window.fetch, context.window.__RESTOCK_CAPTURE_TRACE__.fetchHook);
});
test('successful JSON capture remains reusable and request history is bounded', async () => {
  const context = setup(async () => ({ url, status: 200, clone: () => ({ json: async () => ({ optionCombinations: [{ stockQuantity: 1 }] }) }) }));
  for (let i = 0; i < 20; i++) await context.window.fetch(url);
  await new Promise(r => setImmediate(r));
  assert.equal(context.window.__RESTOCK_CAPTURE_TRACE__.requests.length, 12);
  assert.equal(context.window.__RESTOCK_CAPTURED_RESPONSES__.length, 12);
  assert.equal(context.window.__RESTOCK_CAPTURED_RESPONSES__[0].data.optionCombinations[0].stockQuantity, 1);
});

test('records script and runtime failures without keeping message or URL', () => {
  const context = setup(async () => ({}));
  context.errorListener({ target: { tagName: 'SCRIPT' }, message: 'private' });
  context.errorListener({ target: context.window, message: 'private' });
  const trace = context.window.__RESTOCK_CAPTURE_TRACE__;
  assert.equal(trace.scriptErrors, 1);
  assert.equal(trace.jsErrors, 1);
  assert.equal(JSON.stringify(trace).includes('private'), false);
});
