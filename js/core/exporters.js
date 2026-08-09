// The export formats, as data.
//
// One entry per format: what it is called, which modes it applies to, and how
// to produce it. The dialog derives its tabs from this array rather than
// hard-coding them, so adding `.mid` later is one builder plus one entry -
// not another branch in three places.
//
// `render` returns { text } for the textual formats or { blob, level } for
// the rendered ones, and the dialog treats those uniformly.

import { exportHeader } from './export-h.js';
import { exportFmf } from './export-fmf.js';
import { renderWav } from './export-wav.js';
import { exportProjectFile } from './persist.js';
import { buildTune } from './badge-tune.js';

export const EXPORTERS = [
  {
    id: 'h',
    label: '.h',
    ext: '.h',
    mime: 'text/plain',
    modes: ['mono'],
    text: true, // has a preview pane and a Copy button
    // Mono exports are blocked while notes overlap: the badge has one voice,
    // so a conflict has no correct answer and silently picking one would be
    // worse than refusing.
    blockedByConflicts: true,
    render: (doc, opts = {}) => exportHeader(doc, opts.symbol, { region: opts.region }),
  },
  {
    id: 'fmf',
    label: '.fmf',
    ext: '.fmf',
    mime: 'text/plain',
    modes: ['mono'],
    text: true,
    blockedByConflicts: true,
    render: (doc, opts = {}) => exportFmf(doc, { region: opts.region }),
  },
  {
    id: 'cbt',
    label: '.cbt',
    ext: '.cbt',
    mime: 'application/octet-stream',
    // Every track, not just the melody: a .cbt holds the whole song and the
    // badge picks its part. A mono project is simply the one-track case.
    modes: ['mono', 'poly'],
    text: false,
    // Overlaps have an answer here - the same monophony rule the .h exporter
    // uses, applied per track - so unlike .h this does not need blocking.
    blockedByConflicts: false,
    // A region export would need a rebased origin the badge cannot express:
    // the file starts at song time zero by definition.
    wholeSongOnly: true,
    // Deliberately NOT opts.symbol: that is a C identifier for the .h file
    // (`TETRIS_THEME`), while this name is rendered on the badge's screen and
    // wants to read like a title.
    render: (doc) => {
      const built = buildTune(doc, { name: doc.name });
      return { blob: new Blob([built.bytes], { type: 'application/octet-stream' }), warnings: built.warnings };
    },
  },
  {
    id: 'wav',
    label: '.wav',
    ext: '.wav',
    mime: 'audio/wav',
    modes: ['mono', 'poly'],
    text: false,
    blockedByConflicts: false,
    render: (doc, opts = {}) => renderWav(doc, { region: opts.region, stereo: opts.stereo }),
  },
  {
    id: 'json',
    label: 'Project',
    ext: '.chipseq.json',
    mime: 'application/json',
    modes: ['mono', 'poly'],
    text: false,
    blockedByConflicts: false,
    // The project file is the whole document, so a region would be a lie.
    wholeSongOnly: true,
    render: (doc) => ({ blob: exportProjectFile(doc) }),
  },
];

export function exporterById(id) {
  return EXPORTERS.find((e) => e.id === id) || null;
}

export function exportersFor(mode) {
  return EXPORTERS.filter((e) => e.modes.includes(mode));
}
