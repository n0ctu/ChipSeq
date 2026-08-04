// Collapsible tool-sidebar sections with remembered fold state.

const KEY = 'chipseq.v1.sections';

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

export function initSectionFold(section, key) {
  const head = section.querySelector('.tool-head');
  if (loadState()[key] === false) section.classList.add('folded');
  head.addEventListener('click', () => {
    section.classList.toggle('folded');
    const s = loadState();
    s[key] = !section.classList.contains('folded');
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {}
  });
}

// Show the sidebar's hint only when no tool section is applicable.
export function updateEmptyHint() {
  const empty = document.getElementById('tools-empty');
  if (!empty) return;
  empty.hidden = [...document.querySelectorAll('.tool-section')].some((s) => !s.hidden);
}
