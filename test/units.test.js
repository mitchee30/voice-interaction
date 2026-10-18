'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SentenceSplitter } = require('../sentence_splitter');
const { normalizeMenu, buildLine, sanitizeCart, applyOp, lineLabel, cartTotal, unitPrice } = require('../menu_store');
const { plan } = require('../providers/mock');
const { buildTools, buildSystemPrompt, asrHint } = require('../order_agent');
const { MENU } = require('./helpers');
const rules = require('../turn_rules');
const { sleep, Limiter, BufferedStream } = require('../async_utils');

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


test('rules: backchannels are recognized, real requests are not', () => {
  for (const t of ['嗯。', '嗯嗯', '好的', '对对', 'OK.', 'Uh huh', 'mhm', 'okay']) assert.ok(rules.isBackchannel(t), t);
  for (const t of ['不对', '等一下', 'wait', 'no', '换成燕麦奶', '好的，再来一杯']) assert.ok(!rules.isBackchannel(t), t);
});

test('rules: echo of the assistant vs. the customer repeating a short option', () => {
  const spoken = '好的，我帮你加了一杯珍珠奶茶，少冰。还要别的吗？';
  assert.ok(rules.isEcho('我帮你加了一杯珍珠奶茶', spoken));
  assert.ok(rules.isEcho('我帮你家了一杯珍珠奶', spoken), 'misrecognized echo still matches');
  assert.ok(!rules.isEcho('珍珠奶茶', spoken), 'short answers are never echo');
  assert.ok(!rules.isEcho('换成燕麦奶', spoken));
  assert.ok(rules.isEcho('I added one pearl milk tea', 'OK, I added one pearl milk tea. Anything else?'));
  assert.ok(!rules.isEcho('make it less sugar', 'OK, I added one pearl milk tea. Anything else?'));
});

test('rules: unfinished sentences', () => {
  for (const t of ['我要一杯珍珠奶茶，还有', '一杯', '我要一杯……', '还有。', 'one pearl milk tea and', 'can I get']) assert.ok(rules.looksIncomplete(t), t);
  for (const t of ['我要一杯珍珠奶茶。', '少冰', '可以给我推荐一下吗', 'one pearl milk tea.', '好的']) assert.ok(!rules.looksIncomplete(t), t);
});

test('rules: typical speech-recognition hallucinations', () => {
  for (const t of ['谢谢观看！', '请不吝点赞 订阅 转发 打赏支持明镜与点点栏目', 'Thanks for watching!', '……', '♪♪']) assert.ok(rules.isHallucination(t), t);
  for (const t of ['谢谢', '一杯珍珠奶茶', 'thank you']) assert.ok(!rules.isHallucination(t), t);
});

test('async: Limiter caps concurrency, BufferedStream keeps order', async () => {
  const lim = new Limiter(2);
  let running = 0;
  let peak = 0;
  await Promise.all(
    [1, 2, 3, 4, 5].map(() =>
      lim.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await sleep(10);
        running--;
      }),
    ),
  );
  assert.equal(peak, 2);

  const bs = new BufferedStream();
  bs.push('a');
  setTimeout(() => {
    bs.push('b');
    bs.end();
  }, 10);
  const got = [];
  for await (const x of bs) got.push(x);
  assert.deepEqual(got, ['a', 'b']);

  const ac = new AbortController();
  const p = sleep(1000, ac.signal);
  ac.abort();
  await assert.rejects(p, /aborted/);
});
