# Presets on a multi-channel recorder

Measured against a real 32-channel NVR (UNIX IPM32R32P, 192.168.12.129).

## The finding

Presets ARE already channel-scoped and the tokens prove it:

    Media1_Profile1_Preset001 | Preset001 | position: null
    Media1_Profile1_Preset002 | Preset002 | position: null
    ... 128 of them

The panel header correctly reads "Presets — Channel 1". This is NOT the
Stream URLs bug repeated.

The real problem: **the NVR reports 128 empty preset SLOTS**, not presets an
operator saved. Every one has a generic `PresetNNN` name and a null position,
meaning it was never set. The handful of real presets — if any — are buried in a
128-row list of identical placeholders, and each row carries Go to / Rename /
Delete actions that are meaningless for a slot that holds nothing.

## What to change

- **Separate saved presets from empty slots.** A preset with a real position, or
  a name the operator clearly chose (not `PresetNNN`), is a saved preset. Show
  those first and prominently.
- **Do not render 128 dead rows.** Empty slots should be collapsed behind a
  summary — a count, expandable if someone genuinely wants to target a specific
  slot number. The default view must show what exists, not what could exist.
- **Do not offer meaningless actions.** "Go to" and "Delete" on a slot that was
  never set do nothing useful; a camera may even fault on them. Saving INTO a
  chosen empty slot is legitimate and should stay possible.
- **Judge emptiness from device data, never by parsing a name alone.** A null
  position is the strong signal. Treating any `PresetNNN` name as empty would
  hide a real preset an operator left at its default name — check position first
  and use the name only as a weak secondary hint.
- **Keep it channel-scoped.** Switching channels must reload that channel's
  presets, as it does today.
- **Single-camera devices must not regress.** A camera with 4 real presets shows
  exactly what it shows today.
