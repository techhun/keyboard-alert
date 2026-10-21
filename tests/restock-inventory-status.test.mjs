import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

function script(name, args) {
  const source = readFileSync(new URL('../android/restock-worker/app/src/main/java/com/techhun/keyboardalert/restock/' + name + '.java', import.meta.url), 'utf8');
  let text = source.split('return String.format(Locale.ROOT, """')[1].split('""",')[0].replaceAll('\\\\', '\\');
  for (const value of args) text = text.replace('%s', JSON.stringify(value));
  return text;
}
async function snapshot(status, stock, mode, usable = true, noOptions = false) {
  const api = 'https://m.smartstore.naver.com/i/v2/channels/testchannel/products/123456';
  const data = { id: 123456, name: 'Test', statusType: status, stockQuantity: stock,
    optionCombinations: noOptions ? [] : [{ id: 1, optionName1: 'Test option', stockQuantity: stock, usable }] };
  let result;
  const context = {
    URL, location: { href: 'https://m.smartstore.naver.com/test/products/123456', origin: 'https://m.smartstore.naver.com', pathname: '/test/products/123456' },
    document: { title: 'Test', scripts: [], readyState: 'complete', documentElement: { innerHTML: '' } },
    performance: { now: () => 3000, getEntriesByType: () => [{ name: api }] },
    window: { RestockBridge: { onResult: value => { result = JSON.parse(value); } },
      __RESTOCK_CAPTURED_RESPONSES__: mode === 'capture' ? [{ url: api, status: 200, data }] : [] },
    fetch: async () => ({ ok: true, status: 200, url: api, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(data) })
  };
  const code = mode === 'direct' ? script('InventoryApiScript', ['123456', api, 'Test'])
    : script('InventoryScript', [api, 'testchannel', '123456', true]);
  vm.runInNewContext(code, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.ok, true);
  return result;
}
for (const mode of ['capture', 'fallback', 'direct']) {
  test(mode + ': OUTOFSTOCK blocks positive stock and SALE restores availability', async () => {
    const blocked = await snapshot('OUTOFSTOCK', 1, mode);
    assert.equal(blocked.options[0].available, false);
    assert.equal(blocked.options[0].stockQuantity, 1);
    const restored = await snapshot('SALE', 1, mode);
    assert.equal(restored.options[0].available, true);
    assert.equal((await snapshot('SALE', 0, mode)).options[0].available, false);
    assert.equal((await snapshot('SALE', 1, mode, false)).options[0].available, false);
  });
  test(mode + ': product without options respects OUTOFSTOCK', async () => {
    assert.equal((await snapshot('OUTOFSTOCK', 1, mode, true, true)).options[0].available, false);
  });
}
