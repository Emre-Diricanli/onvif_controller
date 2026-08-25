# Channel selector + per-channel stream URLs

Verified against a real 16-channel NVR at 192.168.12.129 (CMS/OEM firmware),
streaming H265 on Channel 15. Two changes.

## 1. Channel selector: buttons over the stream, not a sidebar dropdown

Today a multi-channel device gets a `<select>` at the top of the sidebar. Replace
it with a horizontal row of channel-number buttons overlaid on the video, in the
same overlay layer as the existing profile switcher.

- Buttons show the channel NUMBER (1, 2, 3 …), not a long label. On 16+ channels
  a row of numbers is scannable; a column of "Channel 15" strings is not.
- The active channel is visually unmistakable — this is the safety property the
  whole multi-channel feature exists for. An operator must never adjust the
  wrong camera because they misread which channel is selected.
- The row must not obscure the picture: it belongs in the existing translucent
  top overlay alongside the profile switcher, and must scroll horizontally
  rather than wrap into a block that eats the video.
- Keyboard: arrow keys move between channels, the row is a proper tablist or
  radiogroup with an accessible name, and the current channel is announced.
- The sidebar `<select>` is removed. Per-channel section headings keep their
  "— Channel N" suffix; that context is still wanted.
- SINGLE-SOURCE DEVICES ARE UNAFFECTED. One video source means no channel row
  at all, exactly as today.

## 2. Stream URLs must be scoped to the selected channel — this is a bug

`GET /api/session/:id/stream-urls` accepts a `profile` query parameter and
IGNORES it: it maps over `session.profiles`, so it returns every profile of
every channel. On the 16-channel NVR the panel rendered a long list of identical
"mainStream" rows, all for the same host, with no indication of which channel
each belonged to. The frontend already passes `profile`; the server does not
honour it.

Fix: when `profile` is supplied, return only the URLs for the video source that
profile belongs to — its main and sub stream — matching how an IP camera behaves
today (one channel, its streams). When `profile` is omitted on a single-source
device, keep current behaviour so nothing regresses.

Each returned entry must be identifiable: keep `name`, `codec` and `resolution`
so "mainStream H265 3840×2160" reads correctly, and never render several rows
that are indistinguishable from one another.
