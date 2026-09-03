/**
 * Persona: AR504-32 — the unit at 192.168.15.101 that motivated the governor.
 *
 * Observed on the real unit (GOVERNOR.md, Parts 1-2):
 *   - full Profile G (Recording + Replay + Search), with 33 recordings;
 *   - under repeated concurrent probing it WEDGES: ONVIF and RTSP both stop
 *     answering while the TCP listener keeps accepting connections (ping died
 *     too, but this mock has no ICMP layer to wedge). The real unit needed a
 *     power cycle; here POST /__reset stands in for it.
 *
 * The wedge trips when MOCK_WEDGE_AFTER (default 16) requests arrive within
 * MOCK_WEDGE_WINDOW_MS (default 2000). While wedged, every request except the
 * /__* introspection endpoints is accepted and never answered — exactly the
 * "TCP connects, ONVIF times out" signature the governor must detect.
 */
export const persona = {
  name: 'ar504',
  defaults: { playbackMode: 'full' },
  create(ctx) {
    const wedgeAfter = Number(process.env.MOCK_WEDGE_AFTER ?? 16);
    const wedgeWindowMs = Number(process.env.MOCK_WEDGE_WINDOW_MS ?? 2000);
    let arrivals = [];
    let wedged = false;

    // 33 recordings were listed on the hardware; the base mock ships two.
    for (let i = ctx.recordings.length + 1; i <= 33; i += 1) {
      ctx.recordings.push({
        token: `Recording_SRC_CH${i}`, sourceId: `SRC_CH${i}`,
        name: `Channel ${i}`, trackToken: `Track_SRC_CH${i}_video`,
      });
    }

    return {
      onRequest(req, res) {
        // Introspection is not ONVIF: it survives the wedge and clears it.
        if (req.url.startsWith('/__')) {
          if (req.method === 'POST' && req.url.startsWith('/__reset')) {
            wedged = false;
            arrivals = [];
          }
          return false;
        }
        const now = Date.now();
        arrivals = arrivals.filter((t) => now - t < wedgeWindowMs);
        if (wedged || arrivals.length + 1 >= wedgeAfter) {
          if (!wedged) {
            wedged = true;
            ctx.callCounts['ar504.wedged'] = 1;
            console.log('  [persona ar504] wedged — ONVIF stops answering, TCP keeps accepting');
          }
          // Accepted and never answered: the observed wedge signature.
          req.resume();
          return true;
        }
        arrivals.push(now);
        return false;
      },
    };
  },
};
