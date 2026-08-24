// views/presets.js — preset list, goto, save current as, rename, delete.
//
// Rename is a save over the existing token (the contract's overwrite path).
// Delete is a two-step inline confirm. Nothing here is optimistic: the list
// only reflects what the device confirmed.

import { api, ApiError } from '../api.js';
import { pressable } from '../gesture.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {HTMLElement} container
 * @param {{ sessionId: string, profile: string, ptz: object, onError: (err: ApiError) => void }} opts
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
export function renderPresets(container, { sessionId, profile, onError }) {
  const cleanups = [];
  let destroyed = false;

  const wrap = el('div', 'presets');
  const status = el('p', 'panel-status', 'Loading presets…');
  const list = el('ul', 'preset-list');

  // --- Save current as ---
  const saveRow = el('div', 'preset-save-row');
  const nameInput = el('input', 'field-input preset-name-input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Preset name';
  nameInput.maxLength = 64;
  const saveBtn = el('button', 'btn btn-primary btn-sm', 'Save current as');
  saveBtn.type = 'button';
  cleanups.push(pressable(saveBtn));
  saveRow.append(nameInput, saveBtn);

  wrap.append(saveRow, status, list);
  container.appendChild(wrap);

  function reportError(err) {
    if (destroyed) return;
    if (err instanceof ApiError) onError(err);
  }

  function setStatus(text) {
    status.textContent = text;
    status.hidden = !text;
  }

  async function refresh() {
    try {
      const { presets } = await api.getPresets(sessionId, profile);
      if (destroyed) return;
      renderList(presets || []);
    } catch (err) {
      if (destroyed) return;
      setStatus('');
      reportError(err);
    }
  }

  function renderList(presets) {
    list.replaceChildren();
    if (presets.length === 0) {
      setStatus('No presets yet. Aim the camera and save the current position.');
      return;
    }
    setStatus('');
    for (const preset of presets) {
      list.appendChild(renderRow(preset));
    }
  }

  function renderRow(preset) {
    const row = el('li', 'preset-row');

    const name = el('span', 'preset-name', preset.name || `Preset ${preset.token}`);

    const actions = el('div', 'preset-actions');

    const goBtn = el('button', 'btn btn-ghost btn-sm', 'Go to');
    goBtn.type = 'button';
    cleanups.push(pressable(goBtn));
    const go = () => {
      goBtn.disabled = true;
      api.gotoPreset(sessionId, profile, preset.token)
        .catch(reportError)
        .finally(() => { if (!destroyed) goBtn.disabled = false; });
    };
    goBtn.addEventListener('click', go);
    cleanups.push(() => goBtn.removeEventListener('click', go));

    const renameBtn = el('button', 'btn btn-ghost btn-sm', 'Rename');
    renameBtn.type = 'button';
    cleanups.push(pressable(renameBtn));

    const deleteBtn = el('button', 'btn btn-ghost btn-sm btn-danger-text', 'Delete');
    deleteBtn.type = 'button';
    cleanups.push(pressable(deleteBtn));

    actions.append(goBtn, renameBtn, deleteBtn);
    row.append(name, actions);

    // --- Inline rename ---
    let renaming = false;
    const startRename = () => {
      if (renaming) return;
      renaming = true;
      const input = el('input', 'field-input preset-rename-input');
      input.type = 'text';
      input.value = preset.name || '';
      input.maxLength = 64;
      row.replaceChild(input, name);
      actions.replaceChildren();
      const confirmBtn = el('button', 'btn btn-primary btn-sm', 'Save');
      confirmBtn.type = 'button';
      const cancelBtn = el('button', 'btn btn-ghost btn-sm', 'Cancel');
      cancelBtn.type = 'button';
      cleanups.push(pressable(confirmBtn), pressable(cancelBtn));
      actions.append(confirmBtn, cancelBtn);
      input.focus();
      input.select();

      const finish = ({ restoreFocus = false } = {}) => {
        renaming = false;
        row.replaceChild(name, input);
        actions.replaceChildren(goBtn, renameBtn, deleteBtn);
        // Cancelling from the keyboard must not strand focus on a removed node.
        if (restoreFocus) renameBtn.focus();
      };
      const confirm = () => {
        const newName = input.value.trim();
        if (!newName) { input.focus(); return; }
        confirmBtn.disabled = true;
        api.savePreset(sessionId, profile, newName, preset.token)
          .then(() => {
            if (destroyed) return;
            finish();
            refresh();
            // refresh() replaces the rows; park focus somewhere stable.
            nameInput.focus();
          })
          .catch((err) => { reportError(err); if (!destroyed) { confirmBtn.disabled = false; } });
      };
      confirmBtn.addEventListener('click', confirm);
      cancelBtn.addEventListener('click', () => finish({ restoreFocus: true }));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') confirm();
        if (e.key === 'Escape') finish({ restoreFocus: true });
      });
    };
    renameBtn.addEventListener('click', startRename);
    cleanups.push(() => renameBtn.removeEventListener('click', startRename));

    // --- Two-step delete confirm ---
    let confirming = false;
    const startDelete = () => {
      if (confirming) return;
      confirming = true;
      deleteBtn.textContent = 'Confirm delete';
      deleteBtn.classList.add('btn-danger-solid');
      const reset = () => {
        confirming = false;
        deleteBtn.textContent = 'Delete';
        deleteBtn.classList.remove('btn-danger-solid');
        document.removeEventListener('pointerdown', cancel, true);
        deleteBtn.removeEventListener('keydown', onKey);
        // Disarming must also disarm the armed second click, or the next
        // single click would delete without a confirm step.
        deleteBtn.removeEventListener('click', onSecondTap);
      };
      const cancel = (e) => {
        if (deleteBtn.contains(e.target)) return;
        reset();
      };
      // Escape disarms the confirm — a keyboard user has no "click elsewhere".
      const onKey = (e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        reset();
      };
      document.addEventListener('pointerdown', cancel, true);
      deleteBtn.addEventListener('keydown', onKey);
      const confirm = () => {
        if (!confirming) return;
        reset();
        deleteBtn.disabled = true;
        api.deletePreset(sessionId, profile, preset.token)
          .then(() => {
            if (destroyed) return;
            refresh();
            // The row is gone after refresh; park focus somewhere stable.
            nameInput.focus();
          })
          .catch((err) => {
            reportError(err);
            if (!destroyed) {
              deleteBtn.disabled = false;
              deleteBtn.textContent = 'Delete';
              deleteBtn.classList.remove('btn-danger-solid');
            }
          });
      };
      const onSecondTap = (e) => { e.stopPropagation(); confirm(); };
      deleteBtn.addEventListener('click', onSecondTap, { once: true });
      cleanups.push(() => {
        document.removeEventListener('pointerdown', cancel, true);
        deleteBtn.removeEventListener('keydown', onKey);
        deleteBtn.removeEventListener('click', onSecondTap);
      });
    };
    deleteBtn.addEventListener('click', startDelete);
    cleanups.push(() => deleteBtn.removeEventListener('click', startDelete));

    return row;
  }

  // --- Save current as ---
  let saving = false;
  const save = () => {
    const name = nameInput.value.trim();
    if (!name || saving) {
      if (!name) nameInput.focus();
      return;
    }
    saving = true;
    saveBtn.disabled = true;
    api.savePreset(sessionId, profile, name, null)
      .then(() => {
        if (destroyed) return;
        nameInput.value = '';
        refresh();
      })
      .catch(reportError)
      .finally(() => {
        if (!destroyed) { saving = false; saveBtn.disabled = false; }
      });
  };
  saveBtn.addEventListener('click', save);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  cleanups.push(() => {
    saveBtn.removeEventListener('click', save);
  });

  refresh();

  return {
    el: wrap,
    destroy() {
      destroyed = true;
      cleanups.forEach((fn) => fn());
    },
  };
}
