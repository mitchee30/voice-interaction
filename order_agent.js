'use strict';

// The ordering "brain": builds the prompt (menu + cart), describes the cart
// tools, and runs the model ⇄ tools loop while streaming text out.

const config = require('./config_data');
const { money, nameIn, lineLabel, cartTotal, unitPrice } = require('./menu_store');

function both(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  const zh = v.zh || '';
  const en = v.en || '';
  return zh && en && zh !== en ? `${zh} / ${en}` : zh || en;
}

function describeMenu(menu) {
  const lines = [];
  lines.push(`Drinks (prices in ${menu.currency}):`);
  for (const it of menu.items) {
    const bits = [`id=${it.id}`, both(it.name), money(it.price)];
    if (it.aliases.length) bits.push(`also called: ${it.aliases.join(', ')}`);
    if (it.description) bits.push(both(it.description));
    if (it.options.length !== menu.optionGroups.length) bits.push(`options: ${it.options.join(', ') || 'none'}`);
    if (it.addons.length !== menu.addons.length) bits.push(`add-ons: ${it.addons.join(', ') || 'none'}`);
    if (it.soldOut) bits.push('SOLD OUT');
    lines.push('- ' + bits.join(' | '));
  }
  if (menu.optionGroups.length) {
    lines.push('', 'Options (key=choice id):');
    for (const g of menu.optionGroups) {
      const cs = g.choices
        .map((c) => `${c.id}=${both(c.name)}${c.price ? ` +${money(c.price)}` : ''}${c.id === g.default ? ' (default)' : ''}`)
        .join('; ');
      lines.push(`- ${g.id} (${both(g.name)}): ${cs}`);
    }
  }
  if (menu.addons.length) {
    lines.push('', 'Add-ons:');
    for (const a of menu.addons) {
      lines.push(`- id=${a.id} | ${both(a.name)} | +${money(a.price)}${a.soldOut ? ' | SOLD OUT' : ''}`);
    }
  }
  return lines.join('\n');
}

function describeCart(cart, menu, lang) {
  if (!cart.length) return 'The cart is empty.';
  const rows = cart.map((l) => `- line_id=${l.id}: ${lineLabel(l, menu, lang)} — ${money(unitPrice(l, menu) * l.qty)}`);
  rows.push(`Total before tax: ${money(cartTotal(cart, menu))}`);
  return rows.join('\n');
}

function buildSystemPrompt({ menu, cart, lang, shopName, instructions }) {
  const langName = lang === 'en' ? 'English' : 'Simplified Chinese';
  return [
    `You are the voice ordering assistant at ${shopName || 'our shop'}, a bubble tea shop. The customer is talking to you out loud through their phone; your words are turned into speech.`,
    '',
    'How to talk:',
    `- Answer in the language the customer just used. If unclear, use ${langName}.`,
    '- Keep each reply to one or two short spoken sentences. No lists, no markdown, no emoji, no item ids.',
    '- Say prices the way people say them out loud. In Chinese: "5块5", "12块2毛5" (not "$5.50"). In English: "$5.50" is fine.',
    '- Before calling a cart tool, begin your reply with a very short acknowledgement ("好的，" / "Sure,") so the customer hears you right away; do not repeat it after the tool result.',
    '- Earlier assistant messages marked "[the customer interrupted …]" were cut off: the customer only heard the part before the mark.',
    '- The customer text comes from speech recognition and may be misheard or cut off mid-sentence. Map similar-sounding words to menu items. If you really cannot tell what they want, ask a short question.',
    '',
    'How to order:',
    '- Only sell what is on the menu below. If something is sold out, say so and suggest something close.',
    '- Use the tools to change the cart. Never say you added, changed or removed something unless the tool call succeeded.',
    '- If the customer does not mention an option (sugar, ice, ...), use the default and do not ask about it; mention it briefly when confirming only if they seem to care.',
    '- To change a drink that is already in the cart, use update_cart_line with its line_id instead of adding a new one.',
    '- After changing the cart, confirm in a few words and ask if they want anything else.',
    '- When they say they are done, read the order back in one short sentence (drinks and total) and tell them to check the cart and tap Checkout.',
    '- You cannot place the order, take payment, change prices or give discounts. Politely decline anything unrelated to ordering.',
    instructions ? `\nShop notes: ${instructions}` : '',
    '',
    describeMenu(menu),
    '',
    'Current cart:',
    describeCart(cart, menu, lang),
  ].join('\n');
}

/** OpenAI-style function tool definitions, with the menu ids as enums. */
function buildTools(menu) {
  const optionProps = {};
  for (const g of menu.optionGroups) {
    optionProps[g.id] = { type: 'string', enum: g.choices.map((c) => c.id), description: both(g.name) };
  }
  const itemIds = menu.items.map((i) => i.id);
  const addonIds = menu.addons.map((a) => a.id);
  const lineFields = {
    qty: { type: 'integer', minimum: 1, maximum: menu.maxQty, description: 'Number of cups' },
    options: { type: 'object', properties: optionProps, additionalProperties: false, description: 'Only the options the customer asked for' },
    addons: { type: 'array', items: addonIds.length ? { type: 'string', enum: addonIds } : { type: 'string' }, description: 'Full list of add-ons for this drink' },
    note: { type: 'string', maxLength: 80, description: 'Short special request that fits no option' },
  };
  return [
    {
      type: 'function',
      function: {
        name: 'add_to_cart',
        description: 'Add a drink to the cart.',
        parameters: {
          type: 'object',
          properties: { item_id: { type: 'string', enum: itemIds }, ...lineFields },
          required: ['item_id'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_cart_line',
        description: 'Change a drink already in the cart (quantity, options, add-ons or note). Fields you leave out stay the same.',
        parameters: {
          type: 'object',
          properties: { line_id: { type: 'string' }, ...lineFields },
          required: ['line_id'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'remove_cart_line',
        description: 'Remove a drink from the cart.',
        parameters: {
          type: 'object',
          properties: { line_id: { type: 'string' } },
          required: ['line_id'],
          additionalProperties: false,
        },
      },
    },
  ];
}

/** Words that help speech recognition spell menu items correctly. */
function asrHint(menu) {
  const words = [];
  for (const it of menu.items) words.push(nameIn(it.name, 'zh'), nameIn(it.name, 'en'), ...it.aliases);
  for (const a of menu.addons) words.push(nameIn(a.name, 'zh'), nameIn(a.name, 'en'));
  for (const g of menu.optionGroups) for (const c of g.choices) words.push(nameIn(c.name, 'zh'));
  const uniq = [...new Set(words.filter(Boolean))];
  return `Bubble tea order. Menu: ${uniq.join(', ')}`.slice(0, 800);
}

/**
 * Runs the model with tools until it stops calling them.
 *   onText(text)        every streamed text chunk
 *   runTool(call)       executes a tool call, returns a JSON-able result
 *   refreshSystem()     returns an updated system prompt after the cart changed
 * Returns the full reply text.
 */
async function runAgent({ provider, messages, tools, context, signal, onText, runTool, refreshSystem, maxRounds = config.maxToolRounds }) {
  let reply = '';
  for (let round = 0; round < maxRounds; round++) {
    let roundText = '';
    let calls = null;
    for await (const ev of provider.chat({ messages, tools, signal, context: context() })) {
      if (signal.aborted) return reply;
      if (ev.type === 'text') {
        roundText += ev.text;
        reply += ev.text;
        onText(ev.text);
      } else if (ev.type === 'tool_calls') {
        calls = ev.calls;
      }
    }
    if (signal.aborted || !calls || !calls.length) return reply;
    if (roundText && !/[\s。！？.!?]$/.test(roundText)) {
      reply += ' ';
      onText(' ');
    }
    messages.push({
      role: 'assistant',
      content: roundText || null,
      tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })),
    });
    for (const c of calls) {
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(runTool(c)) });
    }
    messages[0] = { role: 'system', content: refreshSystem() };
  }
  return reply;
}

module.exports = { buildSystemPrompt, buildTools, describeMenu, describeCart, asrHint, runAgent };
