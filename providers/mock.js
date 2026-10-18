'use strict';

// Demo provider that needs no API key. It cannot hear audio (no speech
// recognition, no voice): the customer types, and replies are spoken by the
// browser. Ordering is understood with simple keyword rules against the menu,
// e.g. "两杯珍珠奶茶少冰加布丁" or "one taro milk tea, no ice".
// It talks to the session through the same chat/tool-call interface as a real
// model, so the whole pipeline is exercised.

const { nameIn, lineLabel, money, cartTotal } = require('../menu_store');

const ZH_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const EN_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// Common ways people say options, mapped onto choice names.
const OPTION_WORDS = {
  sugar: {
    '0': ['无糖', '不要糖', '不加糖', '零糖', 'no sugar', 'zero sugar', 'sugar free', '0%'],
    '30': ['三分糖', '微糖', '少少糖', '30%'],
    '50': ['半糖', '五分糖', 'half sugar', '50%'],
    '70': ['七分糖', '少糖', 'less sugar', '70%'],
    '100': ['全糖', '正常糖', '标准糖', 'full sugar', 'regular sugar', 'normal sugar', '100%'],
  },
  ice: {
    none: ['去冰', '不要冰', '不加冰', '无冰', 'no ice'],
    less: ['少冰', '微冰', 'less ice', 'light ice'],
    regular: ['正常冰', '多冰', 'regular ice', 'normal ice', 'extra ice'],
    hot: ['热的', '热饮', '做热', '要热', 'hot'],
  },
  milk: {
    oat: ['燕麦奶', '燕麦', 'oat milk', 'oat'],
    regular: ['牛奶', '普通奶', 'regular milk', 'dairy'],
  },
};

const REMOVE_WORDS = ['不要了', '删掉', '删除', '去掉', '取消', '拿掉', 'remove', 'delete', 'cancel', "don't want"];
const CHANGE_WORDS = ['换成', '改成', '改为', '换', '改', 'change', 'make it', 'switch', 'instead'];
const DONE_WORDS = ['就这些', '好了', '没了', '结账', '可以了', "that's all", 'that is all', 'done', 'checkout', 'nothing else'];
const MENU_WORDS = ['有什么', '菜单', '推荐', '有啥', 'menu', 'recommend', 'what do you have'];
const TOTAL_WORDS = ['多少钱', '一共', '总共', '总价', 'how much', 'total'];

function isZh(s) {
  return /[一-鿿]/.test(s);
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s，,。.!！?？、]+/g, ' ').trim();
}

function has(text, words) {
  return words.some((w) => text.includes(w));
}

function names(v, aliases = []) {
  const out = [];
  if (typeof v === 'string') out.push(v);
  else if (v) out.push(v.zh, v.en);
  out.push(...aliases);
  return out.filter(Boolean).map((x) => x.toLowerCase());
}

/** Finds non-overlapping mentions, longest phrases first. */
function findMentions(text, entries) {
  const taken = new Array(text.length).fill(false);
  const found = [];
  const all = [];
  for (const e of entries) for (const p of e.phrases) all.push({ e, p });
  all.sort((a, b) => b.p.length - a.p.length);
  for (const { e, p } of all) {
    let from = 0;
    for (;;) {
      const i = text.indexOf(p, from);
      if (i < 0) break;
      from = i + 1;
      // English words must not match inside other words ("oat" in "boat")
      if (/^[a-z]/.test(p) && i > 0 && /[a-z]/.test(text[i - 1])) continue;
      if (/[a-z]$/.test(p) && /[a-z]/.test(text[i + p.length] || '')) continue;
      let free = true;
      for (let k = i; k < i + p.length; k++) if (taken[k]) free = false;
      if (!free) continue;
      for (let k = i; k < i + p.length; k++) taken[k] = true;
      found.push({ entry: e.value, start: i, end: i + p.length });
    }
  }
  found.sort((a, b) => a.start - b.start);
  return { found, taken };
}

function quantityBefore(text, pos) {
  const before = text.slice(Math.max(0, pos - 12), pos);
  let m = before.match(/(\d+)\s*(杯|个|份|x|cups?(\s+of)?)?\s*$/);
  if (m) return Number(m[1]);
  m = before.match(/([一两二三四五六七八九十])\s*(杯|个|份)?\s*$/);
  if (m) return ZH_NUM[m[1]];
  m = before.match(/\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s*(cups?\s*(of)?)?\s*$/);
  if (m) return EN_NUM[m[1]];
  return null;
}

function parse(text, menu) {
  const itemEntries = menu.items.map((it) => ({ value: it, phrases: names(it.name, it.aliases) }));
  const { found: items, taken } = findMentions(text, itemEntries);
  // blank out item names so "珍珠" inside "珍珠奶茶" is not read as an add-on
  const rest = text.split('').map((c, i) => (taken[i] ? ' ' : c)).join('');

  const optEntries = [];
  for (const g of menu.optionGroups) {
    for (const c of g.choices) {
      const words = [...names(c.name, c.aliases), ...((OPTION_WORDS[g.id] || {})[c.id] || [])];
      optEntries.push({ value: { kind: 'option', group: g.id, choice: c.id }, phrases: [...new Set(words)] });
    }
  }
  const addonEntries = menu.addons.map((a) => ({ value: { kind: 'addon', id: a.id }, phrases: names(a.name, a.aliases) }));
  const { found: attrs } = findMentions(rest, [...optEntries, ...addonEntries]);

  // Each attribute belongs to the closest item mentioned before it (or the first item).
  const groups = items.map((m) => ({ item: m.entry, start: m.start, qty: quantityBefore(text, m.start), options: {}, addons: [] }));
  const loose = { options: {}, addons: [] };
  for (const a of attrs) {
    let target = null;
    for (const g of groups) if (g.start <= a.start) target = g;
    if (!target) target = groups[0] || loose;
    if (a.entry.kind === 'option') target.options[a.entry.group] = a.entry.choice;
    else if (!target.addons.includes(a.entry.id)) target.addons.push(a.entry.id);
  }
  return { groups, loose };
}

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return { msg: messages[i], index: i };
  return null;
}

function call(name, args) {
  return { id: 'call_' + Math.random().toString(36).slice(2, 10), name, arguments: JSON.stringify(args) };
}

function* say(s) {
  // stream a few characters at a time, like a real model
  for (let i = 0; i < s.length; i += 6) yield { type: 'text', text: s.slice(i, i + 6) };
}

function plan(userText, { menu, cart }) {
  const text = norm(userText);
  const zh = isZh(userText);
  const { groups, loose } = parse(text, menu);
  const calls = [];
  const notes = [];

  // "不要X了" removes X, but "不要冰" / "不要糖" are options
  const withoutOptionNo = text.replace(/不要(冰|糖|加冰|加糖)/g, '');
  const removing = has(text, REMOVE_WORDS) || (groups.length > 0 && withoutOptionNo.includes('不要'));
  const changing = !removing && has(text, CHANGE_WORDS);

  if (removing) {
    if (groups.length) {
      for (const g of groups) {
        const line = [...cart].reverse().find((l) => l.itemId === g.item.id);
        if (line) calls.push(call('remove_cart_line', { line_id: line.id }));
        else notes.push(zh ? `购物车里没有${nameIn(g.item.name, 'zh')}` : `There is no ${nameIn(g.item.name, 'en')} in your cart`);
      }
    } else if (cart.length) {
      calls.push(call('remove_cart_line', { line_id: cart[cart.length - 1].id }));
    }
    return { calls, notes, zh };
  }

  if (changing || (!groups.length && (Object.keys(loose.options).length || loose.addons.length))) {
    const g = groups[0];
    const line = g ? [...cart].reverse().find((l) => l.itemId === g.item.id) : cart[cart.length - 1];
    const changes = g || loose;
    // "改成两杯" / "make it two"
    const qm = text.match(/(?:改成|换成|改为|要|make it|change to)\s*(\d+|[一两二三四五六七八九十]|one|two|three|four|five|six|seven|eight|nine|ten)\s*(杯|cups?)?/);
    const newQty = qm ? Number(qm[1]) || ZH_NUM[qm[1]] || EN_NUM[qm[1]] : null;
    if (line && (Object.keys(changes.options).length || changes.addons.length || newQty)) {
      const args = { line_id: line.id };
      if (Object.keys(changes.options).length) args.options = changes.options;
      if (changes.addons.length) args.addons = [...new Set([...line.addons, ...changes.addons])];
      if (newQty) args.qty = newQty;
      calls.push(call('update_cart_line', args));
      return { calls, notes, zh };
    }
    if (!g) return { calls, notes, zh, fallback: true };
  }

  for (const g of groups) {
    const args = { item_id: g.item.id, qty: g.qty || 1 };
    if (Object.keys(g.options).length) args.options = g.options;
    if (g.addons.length) args.addons = g.addons;
    calls.push(call('add_to_cart', args));
  }
  return { calls, notes, zh };
}

const ZH_COUNT = ['', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'];

/** "两杯珍珠奶茶，少冰，加布丁" / "2 Pearl Milk Tea, less ice, plus Pudding" — easy to read aloud. */
function spokenLabel(line, menu, zh) {
  const item = menu.itemById.get(line.itemId);
  if (!item) return line.itemId;
  const lang = zh ? 'zh' : 'en';
  const bits = [];
  for (const gid of item.options) {
    const g = menu.groupById.get(gid);
    const cid = line.options && line.options[gid];
    if (cid && cid !== g.default) bits.push(nameIn(g.choices.find((c) => c.id === cid).name, lang));
  }
  for (const a of line.addons || []) {
    const ad = menu.addonById.get(a);
    if (ad) bits.push((zh ? '加' : 'plus ') + nameIn(ad.name, lang));
  }
  const name = nameIn(item.name, lang);
  const head = zh ? `${ZH_COUNT[line.qty] || line.qty}杯${name}` : `${line.qty} ${name}`;
  return [head, ...bits].join(zh ? '，' : ', ');
}

function explain(error, zh) {
  const sold = /^(.+) is sold out$/.exec(error);
  if (sold) return zh ? `${sold[1]}今天卖完了` : `${sold[1]} is sold out today`;
  return zh ? '这个我改不了' : "I couldn't do that";
}

function replyAfterTools(results, zh, menu) {
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  const parts = [];
  if (ok.length) {
    const what = ok.map((r) => (r.line ? spokenLabel(r.line, menu, zh) : r.label)).join(zh ? '；' : '; ');
    const verbs = { add_to_cart: zh ? '加了' : 'Added', update_cart_line: zh ? '改好了' : 'Updated', remove_cart_line: zh ? '删掉了' : 'Removed' };
    const v = verbs[ok[0].tool] || (zh ? '好了' : 'Done');
    parts.push(zh ? `好的，${v}${what}。` : `OK. ${v} ${what}.`);
  }
  for (const r of bad) parts.push(zh ? `抱歉，${explain(r.error, zh)}。` : `Sorry, ${explain(r.error, zh)}.`);
  parts.push(zh ? '还要别的吗？' : 'Anything else?');
  return parts.join(zh ? '' : ' ');
}

function createMockProvider() {
  async function* chat({ messages, context }) {
    const { menu, cart } = context;
    const u = lastUser(messages);
    if (!u) return;
    const userText = u.msg.content || '';
    const zh = isZh(userText) || (!/[a-z]/i.test(userText) && context.lang !== 'en');
    const after = messages.slice(u.index + 1);

    // Second round: we already called tools, now describe what happened.
    const toolMsgs = after.filter((m) => m.role === 'tool');
    if (toolMsgs.length) {
      const results = toolMsgs.map((m) => {
        try {
          return JSON.parse(m.content);
        } catch {
          return { ok: false, error: 'error' };
        }
      });
      yield* say(replyAfterTools(results, zh, menu));
      return;
    }

    const text = norm(userText);
    const p = plan(userText, { menu, cart });
    if (p.calls.length) {
      yield { type: 'tool_calls', calls: p.calls };
      return;
    }
    if (p.notes.length) {
      yield* say(p.notes.join(zh ? '。' : '. ') + (zh ? '。' : '.'));
      return;
    }
    if (has(text, DONE_WORDS)) {
      yield* say(
        cart.length
          ? zh
            ? `好的，一共${money(cartTotal(cart, menu))}，请核对购物车，然后点结账。`
            : `Great, that's ${money(cartTotal(cart, menu))} before tax. Please check your cart and tap Checkout.`
          : zh
            ? '购物车还是空的，想喝点什么？'
            : 'Your cart is empty. What would you like?',
      );
      return;
    }
    if (has(text, TOTAL_WORDS)) {
      yield* say(zh ? `现在一共${money(cartTotal(cart, menu))}，不含税。` : `It's ${money(cartTotal(cart, menu))} before tax.`);
      return;
    }
    if (has(text, MENU_WORDS)) {
      const picks = menu.items.filter((i) => !i.soldOut).slice(0, 3).map((i) => nameIn(i.name, zh ? 'zh' : 'en'));
      yield* say(zh ? `我们有${picks.join('、')}等等，想来哪一杯？` : `We have ${picks.join(', ')} and more. What would you like?`);
      return;
    }
    const example = menu.items.find((i) => !i.soldOut);
    yield* say(
      zh
        ? `抱歉，我没听懂。可以这样说：一杯${nameIn(example?.name, 'zh')}，少冰。`
        : `Sorry, I didn't catch that. Try: one ${nameIn(example?.name, 'en')}, less ice.`,
    );
  }

  return {
    name: 'mock',
    capabilities: { asr: false, tts: false },
    chat,
    async transcribe() {
      throw new Error('mock provider has no speech recognition');
    },
    async synthesize() {
      throw new Error('mock provider has no speech synthesis');
    },
  };
}

module.exports = { createMockProvider, parse, plan, lineLabel };
