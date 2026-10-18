'use strict';

// Menu + cart logic shared by the AI tools, the prompt and the mock provider.
//
// Menu format (prices are integer cents):
// {
//   currency: 'CAD',
//   items: [{ id, name: {zh, en}, price, soldOut?, aliases?: [], options?: [groupId], addons?: true|false|[addonId] }],
//   optionGroups: [{ id, name: {zh, en}, default, choices: [{ id, name: {zh, en}, price?, aliases?: [] }] }],
//   addons: [{ id, name: {zh, en}, price, soldOut?, aliases?: [] }],
//   maxQty?: 20
// }
//
// Cart line: { id, itemId, qty, options: {groupId: choiceId}, addons: [addonId], note }

const crypto = require('crypto');

function text(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return v.zh || v.en || Object.values(v)[0] || '';
}

function nameIn(v, lang) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return (lang === 'en' ? v.en || v.zh : v.zh || v.en) || text(v);
}

function assertId(id, what) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(id)) {
    throw new Error(`menu: invalid ${what} id ${JSON.stringify(id)}`);
  }
}

function cents(v, what) {
  const n = Number(v || 0);
  if (!Number.isInteger(n) || n < 0 || n > 100000) throw new Error(`menu: ${what} price must be integer cents`);
  return n;
}

/** Validates a menu and builds lookup maps. Throws on bad input. */
function normalizeMenu(raw) {
  if (!raw || !Array.isArray(raw.items)) throw new Error('menu: items[] is required');
  const optionGroups = (raw.optionGroups || []).map((g) => {
    assertId(g.id, 'option group');
    const choices = (g.choices || []).map((c) => {
      assertId(c.id, `choice in ${g.id}`);
      return { id: c.id, name: c.name || c.id, price: cents(c.price, `${g.id}.${c.id}`), aliases: c.aliases || [] };
    });
    if (!choices.length) throw new Error(`menu: option group ${g.id} has no choices`);
    const def = choices.some((c) => c.id === g.default) ? g.default : choices[0].id;
    return { id: g.id, name: g.name || g.id, default: def, choices };
  });
  const addons = (raw.addons || []).map((a) => {
    assertId(a.id, 'addon');
    return { id: a.id, name: a.name || a.id, price: cents(a.price, a.id), soldOut: !!a.soldOut, aliases: a.aliases || [] };
  });
  const allGroupIds = optionGroups.map((g) => g.id);
  const allAddonIds = addons.map((a) => a.id);
  const items = raw.items.map((it) => {
    assertId(it.id, 'item');
    const options = Array.isArray(it.options) ? it.options.filter((g) => allGroupIds.includes(g)) : allGroupIds;
    const itemAddons = it.addons === false ? [] : Array.isArray(it.addons) ? it.addons.filter((a) => allAddonIds.includes(a)) : allAddonIds;
    return {
      id: it.id,
      name: it.name || it.id,
      price: cents(it.price, it.id),
      soldOut: !!it.soldOut,
      aliases: it.aliases || [],
      description: it.description || null,
      options,
      addons: itemAddons,
    };
  });
  const ids = new Set();
  for (const it of items) {
    if (ids.has(it.id)) throw new Error(`menu: duplicate item id ${it.id}`);
    ids.add(it.id);
  }
  return {
    currency: raw.currency || 'CAD',
    maxQty: Number.isInteger(raw.maxQty) ? raw.maxQty : 20,
    items,
    optionGroups,
    addons,
    itemById: new Map(items.map((i) => [i.id, i])),
    groupById: new Map(optionGroups.map((g) => [g.id, g])),
    addonById: new Map(addons.map((a) => [a.id, a])),
  };
}

function money(c) {
  return `$${(c / 100).toFixed(2)}`;
}

function newLineId() {
  return 'v' + crypto.randomBytes(4).toString('hex');
}

/**
 * Builds a valid cart line from loose input (AI tool args or a client snapshot).
 * Returns { ok: true, line } or { ok: false, error }.
 */
function buildLine(input, menu, base) {
  const itemId = input.itemId || input.item_id || (base && base.itemId);
  const item = menu.itemById.get(itemId);
  if (!item) return { ok: false, error: `unknown item ${itemId}` };
  if (item.soldOut && !base) return { ok: false, error: `${text(item.name)} is sold out` };

  let qty = input.qty != null ? Number(input.qty) : base ? base.qty : 1;
  if (!Number.isInteger(qty) || qty < 1) return { ok: false, error: 'qty must be a whole number ≥ 1' };
  if (qty > menu.maxQty) return { ok: false, error: `at most ${menu.maxQty} per line` };

  const options = {};
  const given = input.options && typeof input.options === 'object' ? input.options : {};
  for (const gid of item.options) {
    const g = menu.groupById.get(gid);
    const want = given[gid] != null ? String(given[gid]) : base && base.options ? base.options[gid] : undefined;
    if (want == null) {
      options[gid] = g.default;
    } else if (g.choices.some((c) => c.id === want)) {
      options[gid] = want;
    } else {
      return { ok: false, error: `invalid ${gid} choice ${want}; valid: ${g.choices.map((c) => c.id).join(', ')}` };
    }
  }
  for (const gid of Object.keys(given)) {
    if (!item.options.includes(gid)) return { ok: false, error: `${gid} does not apply to ${text(item.name)}` };
  }

  let addons = Array.isArray(input.addons) ? input.addons.map(String) : base ? base.addons : [];
  addons = [...new Set(addons)];
  for (const a of addons) {
    const ad = menu.addonById.get(a);
    if (!ad || !item.addons.includes(a)) return { ok: false, error: `add-on ${a} is not available for ${text(item.name)}` };
    if (ad.soldOut && !(base && base.addons.includes(a))) return { ok: false, error: `${text(ad.name)} is sold out` };
  }

  let note = input.note != null ? String(input.note) : base ? base.note : '';
  note = note.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80);

  const id = base ? base.id : typeof input.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(input.id) ? input.id : newLineId();
  return { ok: true, line: { id, itemId: item.id, qty, options, addons, note } };
}

function unitPrice(line, menu) {
  const item = menu.itemById.get(line.itemId);
  if (!item) return 0;
  let p = item.price;
  for (const [gid, cid] of Object.entries(line.options || {})) {
    const c = menu.groupById.get(gid)?.choices.find((x) => x.id === cid);
    if (c) p += c.price;
  }
  for (const a of line.addons || []) p += menu.addonById.get(a)?.price || 0;
  return p;
}

function lineTotal(line, menu) {
  return unitPrice(line, menu) * line.qty;
}

function cartTotal(cart, menu) {
  return cart.reduce((s, l) => s + lineTotal(l, menu), 0);
}

/** "珍珠奶茶 ×2（少冰，半糖，加布丁）" */
function lineLabel(line, menu, lang = 'zh') {
  const item = menu.itemById.get(line.itemId);
  if (!item) return line.itemId;
  const parts = [];
  for (const gid of item.options) {
    const g = menu.groupById.get(gid);
    const cid = line.options?.[gid];
    if (!cid || cid === g.default) continue;
    const c = g.choices.find((x) => x.id === cid);
    if (c) parts.push(nameIn(c.name, lang));
  }
  for (const a of line.addons || []) {
    const ad = menu.addonById.get(a);
    if (ad) parts.push((lang === 'en' ? '+' : '加') + nameIn(ad.name, lang));
  }
  if (line.note) parts.push(line.note);
  const qty = line.qty > 1 ? ` ×${line.qty}` : '';
  const extra = parts.length ? (lang === 'en' ? ` (${parts.join(', ')})` : `（${parts.join('，')}）`) : '';
  return `${nameIn(item.name, lang)}${qty}${extra}`;
}

/** Drops invalid lines from a client snapshot. */
function sanitizeCart(lines, menu) {
  if (!Array.isArray(lines)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of lines.slice(0, 50)) {
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id) ? raw.id : newLineId();
    // Passing a base line means "already in the cart": sold-out flags don't remove it.
    const base = { id, itemId: raw.itemId, qty: 1, options: {}, addons: Array.isArray(raw.addons) ? raw.addons.map(String) : [], note: '' };
    const r = buildLine({ qty: raw.qty, options: raw.options, addons: raw.addons, note: raw.note }, menu, base);
    if (!r.ok) continue;
    const line = r.line;
    if (seen.has(line.id)) continue;
    seen.add(line.id);
    out.push(line);
  }
  return out;
}

/**
 * Applies a cart op in place. Ops: {op:'add', line} | {op:'update', line} | {op:'remove', lineId} | {op:'clear'}.
 * Idempotent, so replaying an op on a cart that already has it is harmless.
 */
function applyOp(cart, op) {
  if (op.op === 'add' || op.op === 'update') {
    const i = cart.findIndex((l) => l.id === op.line.id);
    if (i >= 0) cart[i] = op.line;
    else cart.push(op.line);
  } else if (op.op === 'remove') {
    const i = cart.findIndex((l) => l.id === op.lineId);
    if (i >= 0) cart.splice(i, 1);
  } else if (op.op === 'clear') {
    cart.length = 0;
  }
  return cart;
}

module.exports = {
  normalizeMenu,
  buildLine,
  unitPrice,
  lineTotal,
  cartTotal,
  lineLabel,
  sanitizeCart,
  applyOp,
  money,
  nameIn,
  text,
  newLineId,
};
