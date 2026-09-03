/**
 * Persona: Dahua XVR — a hybrid recorder.
 *
 * Observed on the real unit (GOVERNOR.md, Part 2):
 *   - ONVIF answers normally AND the vendor CGI answers on the same device;
 *   - the vendor recording search (/cgi-bin/recordFinder.cgi?action=find)
 *     returns REAL recording entries, in the Dahua items[n].field=value form.
 *
 * The entries below cover the last hours of "today"; the observed trait is
 * that real entries come back, not this particular layout.
 */
export const persona = {
  name: 'dahua-xvr',
  create(ctx) {
    const count = (name) => { ctx.callCounts[name] = (ctx.callCounts[name] ?? 0) + 1; };
    const fmt = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

    function findResult() {
      const now = Date.now();
      const entries = [0, 1].map((i) => {
        const end = new Date(now - i * 3600 * 1000);
        const start = new Date(end.getTime() - 55 * 60 * 1000);
        return `items[${i}].Channel=${i}\n`
          + `items[${i}].StartTime=${fmt(start)}\nitems[${i}].EndTime=${fmt(end)}\n`
          + `items[${i}].FilePath=/mnt/sd/${fmt(start).slice(0, 10)}/001/dav/0${i}/0.dav\n`
          + `items[${i}].Type=dav\nitems[${i}].Length=${end - start}\n`;
      }).join('');
      return `found=2\n${entries}`;
    }

    return {
      onRequest(req, res) {
        if (!req.url.startsWith('/cgi-bin/')) return false;
        const url = new URL(req.url, `http://${ctx.HOST}:${ctx.PORT}`);
        if (url.pathname === '/cgi-bin/recordFinder.cgi' && url.searchParams.get('action') === 'find') {
          count('cgi.recordFinder.find');
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(findResult());
          return true;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return true;
      },
    };
  },
};
