// The tools sidebar: one collapsible card per entry in the tool manifest.
//
// This module imports NO tool. It builds every card from the manifest alone
// and only calls tool.load() the first time a card actually opens, so a tool
// you never touch is never fetched, parsed or wired up.
//
// Fold state is TRI-STATE, which is the part worth understanding:
//
//   absent      "auto" - the card follows its status().on, so a tool that is
//               in play opens itself and one that is not stays out of the way.
//               It re-evaluates as the context changes: select a note that
//               carries an arpeggio and the Harmonics card opens.
//   true/false  the user said so. Sticky from then on, because a card someone
//               deliberately closed must not spring back open every time the
//               selection changes - the app should never fight the user.
//
// The status indicator is drawn for collapsed cards too. That is its main
// job: a closed card still tells you whether the tool is in play.

import { TOOLS } from './tools/manifest.js';
import { readRaw, writeRaw } from '../core/persist.js';

const KEY = 'chipseq.v1.sections';

export function initToolsPanel(ctx) {
  const list = document.getElementById('tools-list');
  const empty = document.getElementById('tools-empty');
  const resetBtn = document.getElementById('tools-reset');

  // id -> { section, head, caret, status, body, tool, mounted }
  const cards = new Map();

  function loadFolds() {
    try {
      const parsed = JSON.parse(readRaw(KEY));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  let folds = loadFolds();
  const saveFolds = () => writeRaw(KEY, JSON.stringify(folds));

  // Auto (absent) follows the tool's own status; an explicit choice wins.
  function shouldBeOpen(tool, status) {
    const explicit = folds[tool.id];
    return explicit === undefined ? !!status.on : !!explicit;
  }

  // ---- card shells (built once, from the manifest only) ----
  for (const tool of TOOLS) {
    const section = document.createElement('section');
    section.className = 'tool-card';
    section.dataset.tool = tool.id;
    section.hidden = true;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'tool-card-head';

    const caret = document.createElement('span');
    caret.className = 'tool-caret';
    caret.textContent = '▾';
    const name = document.createElement('span');
    name.className = 'tool-card-name';
    name.textContent = tool.name;
    const status = document.createElement('span');
    status.className = 'tool-status';
    head.append(caret, name, status);

    const body = document.createElement('div');
    body.className = 'tool-card-body';
    // Stable, derivable ids: a tool's markup is addressable from outside
    // (tests, deep links) without anyone reaching into the panel's internals.
    body.id = `${tool.id}-body`;
    section.id = `sec-${tool.id}`;

    section.append(head, body);
    list.appendChild(section);

    const card = { tool, section, head, caret, status, body, mounted: false };
    cards.set(tool.id, card);

    head.addEventListener('click', () => {
      // An explicit toggle leaves auto mode for good.
      folds[tool.id] = !section.classList.contains('open');
      saveFolds();
      render();
    });
  }

  resetBtn.addEventListener('click', () => {
    folds = {};
    saveFolds();
    render();
  });

  // ---- mounting ----
  // Loading is async but the card opens immediately, so the box never appears
  // to lag behind the click; the body fills in a tick later.
  async function mount(card) {
    if (card.mounted) return;
    card.mounted = true; // claim it first - two rapid opens must not double-mount
    try {
      const mod = await card.tool.load();
      mod.mount(card.body, ctx);
    } catch (err) {
      card.mounted = false;
      card.body.textContent = 'This tool failed to load.';
      console.error(`tool "${card.tool.id}" failed to load:`, err);
    }
  }

  function render() {
    let anyVisible = false;
    for (const card of cards.values()) {
      const applicable = card.tool.when(ctx);
      card.section.hidden = !applicable;
      if (!applicable) continue;
      anyVisible = true;

      const status = card.tool.status(ctx);
      // The indicator is rendered whether the card is open or closed.
      card.status.textContent = status.label || '';
      card.status.classList.toggle('on', !!status.on);
      card.head.title = shouldBeOpen(card.tool, status)
        ? `Collapse ${card.tool.name}`
        : `Expand ${card.tool.name}`;

      const open = shouldBeOpen(card.tool, status);
      card.section.classList.toggle('open', open);
      card.caret.textContent = open ? '▾' : '▸';
      if (open) mount(card);
    }
    empty.hidden = anyVisible;
    resetBtn.hidden = Object.keys(folds).length === 0;
  }

  ctx.store.subscribe(['doc', 'song', 'notes', 'tracks', 'harmonics', 'automation'], render);
  ctx.uiStore.subscribe(['selection', 'instrument'], render);
  render();

  return {
    // Force a tool open regardless of its fold state - used when another part
    // of the UI hands work to it (the tracks panel's instrument picker).
    reveal(id) {
      const card = cards.get(id);
      if (!card) return;
      folds[id] = true;
      saveFolds();
      render();
      card.section.scrollIntoView({ block: 'nearest' });
    },
    refresh: render,
  };
}
