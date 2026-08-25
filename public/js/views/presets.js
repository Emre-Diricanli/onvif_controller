// views/presets.js — preset list, goto, save current as, rename, delete.
//
// Rename is a save over the existing token (the contract's overwrite path).
// Delete is a two-step inline confirm. Nothing here is optimistic: the list
// only reflects what the device confirmed.
//
// Recorders report their full slot capacity, not just saved presets
// (measured: 128 rows on a 32-channel NVR, every one position: null). Slots
// that were never set are split out of the saved list and collapsed behind a
// summary row — the panel shows what exists, not what could exist. A device
// that reports only real presets renders exactly the flat list it always has.

import { api, ApiError } from '../api.js';
import { pressable } from '../gesture.js';
import { spring, prefersReducedMotion } from '../spring.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// The placeholder names recorders hand to slots that were never set
// (Preset001…Preset128 on the measured NVR). Used only as a weak hint — see
// isEmptySlot.
const GENERIC_SLOT_NAME = /^\s*preset[\s_-]*\d+\s*$/i;

/**
 * Empty slots are judged from device data, never from the name alone.
 *
 * A null position is the strong signal: the slot was never set. The generic
 * PresetNNN name is only a WEAK secondary hint — it can mark a position-less
 * slot as empty, but it can never demote a preset that has a real position,
 * because an operator may have left a genuine preset at its default name.
 * Likewise a position-less slot with an operator-chosen name counts as saved,
 * since some devices never report positions at all.
 */
function isEmptySlot(preset) {
  if (preset.position) return false;
  const name = String(preset.name ?? '');
  return name === '' || GENERIC_SLOT_NAME.test(name);
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
  const slotsHost = el('div', 'preset-slots-host');

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

  wrap.append(saveRow, status, list, slotsHost);
  container.appendChild(wrap);

  // Collapsed state of the empty-slots summary survives refresh() so a save
  // into a slot does not snap the section shut under the operator's pointer.
  let slotsOpen = false;
  let slotsSpring = null;

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
    if (slotsSpring) { slotsSpring.stop(); slotsSpring = null; }
    list.replaceChildren();
    slotsHost.replaceChildren();
    if (presets.length === 0) {
      setStatus('No presets yet. Aim the camera and save the current position.');
      return;
    }
    // Saved presets first — that is what the panel is for. Order within each
    // group is the device's own order.
    const saved = [];
    const emptySlots = [];
    for (const preset of presets) {
      (isEmptySlot(preset) ? emptySlots : saved).push(preset);
    }
    setStatus(saved.length === 0
      ? 'No saved presets yet. Aim the camera and save the current position.'
      : '');
    for (const preset of saved) {
      list.appendChild(renderRow(preset));
    }
    if (emptySlots.length > 0) {
      slotsHost.appendChild(renderSlotsSection(emptySlots));
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

  // An empty slot row carries no Go to / Delete — those are meaningless (and
  // can fault the camera) on a slot that was never set. The one legitimate
  // action is saving the current position INTO this slot, which stays possible.
  function renderSlotRow(preset) {
    const row = el('li', 'preset-row preset-row-empty');

    const name = el('span', 'preset-name', preset.name || `Preset ${preset.token}`);
    const actions = el('div', 'preset-actions');

    const saveBtn = el('button', 'btn btn-ghost btn-sm', 'Save here');
    saveBtn.type = 'button';
    cleanups.push(pressable(saveBtn));
    const saveHere = () => {
      // Reuse the top name field when the operator typed one; otherwise keep
      // the slot's existing label — the token, not the name, does the targeting.
      const presetName = nameInput.value.trim() || preset.name || `Preset ${preset.token}`;
      saveBtn.disabled = true;
      api.savePreset(sessionId, profile, presetName, preset.token)
        .then(() => {
          if (destroyed) return;
          nameInput.value = '';
          refresh();
          // refresh() replaces the rows; park focus somewhere stable.
          nameInput.focus();
        })
        .catch(reportError)
        .finally(() => { if (!destroyed) saveBtn.disabled = false; });
    };
    saveBtn.addEventListener('click', saveHere);
    cleanups.push(() => saveBtn.removeEventListener('click', saveHere));

    actions.append(saveBtn);
    row.append(name, actions);
    return row;
  }

  // Collapsed-by-default summary of slots that were never set, expandable for
  // the rare case of targeting a specific slot number. Keyboard operable
  // (native button committing on click), aria-expanded mirrors the state, and
  // the reveal is driven by a spring — pointer-driven motion never comes from
  // CSS, and reduced motion snaps instead of animating.
  function renderSlotsSection(emptySlots) {
    const section = el('div', 'preset-slots');

    const toggle = el('button', 'preset-slots-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', 'preset-slots-panel');
    toggle.setAttribute('aria-expanded', String(slotsOpen));
    const label = el('span', 'preset-slots-label',
      `${emptySlots.length} empty ${emptySlots.length === 1 ? 'slot' : 'slots'}`);
    const chevron = el('span', 'preset-slots-chevron', '⌄');
    chevron.setAttribute('aria-hidden', 'true');
    toggle.append(label, chevron);
    cleanups.push(pressable(toggle, { scale: 0.985 }));

    const panel = el('ul', 'preset-list preset-slots-panel');
    panel.id = 'preset-slots-panel';
    for (const preset of emptySlots) {
      panel.appendChild(renderSlotRow(preset));
    }

    section.classList.toggle('preset-slots-open', slotsOpen);
    panel.hidden = !slotsOpen;
    section.append(toggle, panel);

    // Re-renders (e.g. after refresh) appear at rest; the spring only runs
    // when the operator toggles.
    let value = slotsOpen ? 1 : 0;

    const apply = (v) => {
      value = v;
      panel.style.opacity = String(v);
      panel.style.transform = prefersReducedMotion()
        ? 'none'
        : `translateY(${(1 - v) * -8}px)`;
    };
    const setOpen = (open) => {
      slotsOpen = open;
      toggle.setAttribute('aria-expanded', String(open));
      section.classList.toggle('preset-slots-open', open);
      if (slotsSpring) { slotsSpring.stop(); slotsSpring = null; }
      if (open) panel.hidden = false;
      const finish = () => {
        slotsSpring = null;
        if (!open) panel.hidden = true;
        panel.style.opacity = '';
        panel.style.transform = '';
      };
      if (prefersReducedMotion()) { apply(open ? 1 : 0); finish(); return; }
      slotsSpring = spring({
        from: value,
        to: open ? 1 : 0,
        damping: 1.0,
        response: 0.35,
        onUpdate: apply,
        onComplete: finish,
      });
    };
    const onToggle = () => setOpen(!slotsOpen);
    toggle.addEventListener('click', onToggle);
    cleanups.push(() => {
      toggle.removeEventListener('click', onToggle);
      if (slotsSpring) { slotsSpring.stop(); slotsSpring = null; }
    });

    return section;
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
