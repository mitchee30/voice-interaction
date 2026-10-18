'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SentenceSplitter } = require('../sentence_splitter');
const { normalizeMenu, buildLine, sanitizeCart, applyOp, lineLabel, cartTotal, unitPrice } = require('../menu_store');
const { plan } = require('../providers/mock');
const { buildTools, buildSystemPrompt, asrHint } = require('../order_agent');
const { MENU } = require('./helpers');

const menu = normalizeMenu(MENU);

function feed(text, chunk = 3) {
  const sp = new SentenceSplitter();
  const out = [];
  for (let i = 0; i < text.length; i += chunk) out.push(...sp.push(text.slice(i, i + chunk)));
  out.push(...sp.flush());
  return out;
}

test('splitter: Chinese sentences come out one by one', () => {
  assert.deepEqual(feed('好的！加了一杯珍珠奶茶。还要别的吗？'), ['好的！', '加了一杯珍珠奶茶。', '还要别的吗？']);
});

test('splitter: prices are not sentence ends, English periods are', () => {
  assert.deepEqual(feed('That is $5.50 before tax. Anything else?'), ['That is $5.50 before tax.', 'Anything else?']);
});

test('splitter: long text breaks at a comma after 26 chars', () => {
  const s = '好的我已经帮你把两杯珍珠奶茶都改成了燕麦奶而且都是少冰半糖，另外布丁也加上了';
  const out = feed(s);
  assert.equal(out.length, 2);
  assert.ok(out[0].endsWith('，'));
});

test('splitter: punctuation runs stay together', () => {
  assert.deepEqual(feed('真的吗？！好的……'), ['真的吗？！', '好的……']);
});

test('menu: builds a line with defaults and validates choices', () => {
  const r = buildLine({ itemId: 'pearl-milk-tea', qty: 2, options: { ice: 'less' }, addons: ['pudding'] }, menu);
  assert.ok(r.ok);
  assert.deepEqual(r.line.options, { sugar: '100', ice: 'less', milk: 'regular' });
  assert.equal(unitPrice(r.line, menu), 550 + 100);
  assert.equal(lineLabel(r.line, menu, 'zh'), '珍珠奶茶 ×2（少冰，加布丁）');
  assert.equal(lineLabel(r.line, menu, 'en'), 'Pearl Milk Tea ×2 (Less ice, +Pudding)');

  assert.equal(buildLine({ itemId: 'matcha-latte' }, menu).ok, false, 'sold out');
  assert.equal(buildLine({ itemId: 'nope' }, menu).ok, false);
  assert.equal(buildLine({ itemId: 'pearl-milk-tea', qty: 0 }, menu).ok, false);
  assert.equal(buildLine({ itemId: 'pearl-milk-tea', qty: 99 }, menu).ok, false);
  assert.equal(buildLine({ itemId: 'pearl-milk-tea', options: { ice: 'lava' } }, menu).ok, false);
  assert.equal(buildLine({ itemId: 'mango-pomelo-sago', addons: ['pudding'] }, menu).ok, false, 'no add-ons on this drink');
  assert.equal(buildLine({ itemId: 'jasmine-green-tea', options: { milk: 'oat' } }, menu).ok, false, 'milk does not apply');
});

test('menu: oat milk costs extra', () => {
  const r = buildLine({ itemId: 'taro-milk-tea', options: { milk: 'oat' } }, menu);
  assert.equal(unitPrice(r.line, menu), 625 + 50);
});

test('menu: sanitizeCart drops junk but keeps sold-out lines already in the cart', () => {
  const cart = sanitizeCart(
    [
      { id: 'a', itemId: 'matcha-latte', qty: 1 },
      { id: 'b', itemId: 'ghost', qty: 1 },
      { id: 'c', itemId: 'pearl-milk-tea', qty: 2, options: { ice: 'none' } },
      'junk',
      { id: 'c', itemId: 'pearl-milk-tea', qty: 1 },
    ],
    menu,
  );
  assert.deepEqual(cart.map((l) => l.id), ['a', 'c']);
  assert.equal(cartTotal(cart, menu), 600 + 1100);
});

test('menu: ops are idempotent', () => {
  const line = buildLine({ itemId: 'pearl-milk-tea' }, menu).line;
  const cart = [];
  applyOp(cart, { op: 'add', line });
  applyOp(cart, { op: 'add', line });
  assert.equal(cart.length, 1);
  applyOp(cart, { op: 'remove', lineId: line.id });
  applyOp(cart, { op: 'remove', lineId: line.id });
  assert.equal(cart.length, 0);
});

test('menu: rejects bad menus', () => {
  assert.throws(() => normalizeMenu({}));
  assert.throws(() => normalizeMenu({ items: [{ id: 'a b', price: 1 }] }));
  assert.throws(() => normalizeMenu({ items: [{ id: 'a', price: 1.5 }] }));
  assert.throws(() => normalizeMenu({ items: [{ id: 'a', price: 1 }, { id: 'a', price: 2 }] }));
});

test('agent: tools list menu ids and the prompt contains menu + cart', () => {
  const tools = buildTools(menu);
  assert.deepEqual(tools.map((t) => t.function.name), ['add_to_cart', 'update_cart_line', 'remove_cart_line']);
  assert.ok(tools[0].function.parameters.properties.item_id.enum.includes('taro-milk-tea'));
  const line = buildLine({ itemId: 'pearl-milk-tea' }, menu).line;
  const p = buildSystemPrompt({ menu, cart: [line], lang: 'zh', shopName: 'Test Tea' });
  assert.match(p, /Test Tea/);
  assert.match(p, /id=matcha-latte.*SOLD OUT/);
  assert.match(p, new RegExp(`line_id=${line.id}`));
  assert.match(asrHint(menu), /芋泥波波奶茶/);
});

function calls(text, cart = []) {
  return plan(text, { menu, cart }).calls.map((c) => [c.name, JSON.parse(c.arguments)]);
}

test('mock: understands typical orders', () => {
  assert.deepEqual(calls('两杯珍珠奶茶少冰加布丁，一杯杨枝甘露去冰'), [
    ['add_to_cart', { item_id: 'pearl-milk-tea', qty: 2, options: { ice: 'less' }, addons: ['pudding'] }],
    ['add_to_cart', { item_id: 'mango-pomelo-sago', qty: 1, options: { ice: 'none' } }],
  ]);
  assert.deepEqual(calls('one taro milk tea, no ice, half sugar'), [
    ['add_to_cart', { item_id: 'taro-milk-tea', qty: 1, options: { ice: 'none', sugar: '50' } }],
  ]);
  assert.deepEqual(calls('2 cups of lemon tea hot'), [['add_to_cart', { item_id: 'lemon-green-tea', qty: 2, options: { ice: 'hot' } }]]);
});

test('mock: changes and removals act on the cart', () => {
  const cart = [
    { id: 'a', itemId: 'mango-pomelo-sago', qty: 1, options: {}, addons: [] },
    { id: 'b', itemId: 'pearl-milk-tea', qty: 1, options: {}, addons: [] },
  ];
  assert.deepEqual(calls('不要杨枝甘露了', cart), [['remove_cart_line', { line_id: 'a' }]]);
  assert.deepEqual(calls('珍珠奶茶换成燕麦奶', cart), [['update_cart_line', { line_id: 'b', options: { milk: 'oat' } }]]);
  assert.deepEqual(calls('珍珠奶茶改成两杯', cart), [['update_cart_line', { line_id: 'b', qty: 2 }]]);
  assert.deepEqual(calls('珍珠奶茶不要冰'), [['add_to_cart', { item_id: 'pearl-milk-tea', qty: 1, options: { ice: 'none' } }]]);
});
