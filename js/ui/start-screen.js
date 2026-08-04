// Start screen: recent projects list + new/import actions + drag-drop.

import { listProjects, loadProject, deleteProject } from '../core/persist.js';
import { confirmDialog } from './dialogs.js';

export function initStartScreen({ onOpenProject, onNewProject, onFilePicked }) {
  const list = document.getElementById('recent-list');

  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  function render() {
    const projects = listProjects();
    if (!projects.length) {
      list.innerHTML = '<li class="recent-empty">No projects yet - create one!</li>';
      return;
    }
    list.innerHTML = '';
    for (const p of projects) {
      const li = document.createElement('li');
      li.className = 'recent-item';
      li.innerHTML = `
        <span class="mode-chip">${p.mode === 'mono' ? 'MONO' : 'POLY'}</span>
        <span class="recent-name"></span>
        <span class="recent-meta">${fmtDate(p.updatedAt)}</span>
        <button class="btn btn-icon recent-del" title="Delete project">&#128465;</button>`;
      li.querySelector('.recent-name').textContent = p.name;
      li.addEventListener('click', (e) => {
        if (e.target.closest('.recent-del')) return;
        const doc = loadProject(p.id);
        if (doc) onOpenProject(doc);
        else render();
      });
      li.querySelector('.recent-del').addEventListener('click', async () => {
        if (await confirmDialog('Delete project', `Delete “${p.name}” permanently? This cannot be undone.`, 'Delete')) {
          deleteProject(p.id);
          render();
        }
      });
      list.appendChild(li);
    }
  }

  document.getElementById('btn-new-project').addEventListener('click', onNewProject);

  const fileInput = document.getElementById('file-input');
  document.getElementById('btn-import-midi').addEventListener('click', () => {
    fileInput.accept = '.mid,.midi';
    fileInput.click();
  });
  document.getElementById('btn-open-tune').addEventListener('click', () => {
    fileInput.accept = '.json,.tune.json';
    fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) onFilePicked(fileInput.files[0]);
    fileInput.value = '';
  });

  // global drag & drop
  let dragDepth = 0;
  document.body.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
  });
  document.body.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      document.body.classList.remove('dragging');
    }
  });
  document.body.addEventListener('dragover', (e) => e.preventDefault());
  document.body.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    if (e.dataTransfer.files.length) onFilePicked(e.dataTransfer.files[0]);
  });

  return { render };
}
