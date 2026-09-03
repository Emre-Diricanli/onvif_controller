/**
 * Persona: UNIX IPM32R32P — a 32-channel NVR.
 *
 * Observed on the real unit (GOVERNOR.md, Part 2):
 *   - 32 channels;
 *   - NO Profile G: no recording, replay or search services at all;
 *   - pull-point events name the channel in the message's own Source
 *     simpleItem — Name="Source", Value="Media7"-style — NOT in a profile
 *     token and NOT in a VideoSourceConfigurationToken item;
 *   - a very high event rate: ~485 motion events/minute were seen.
 *
 * MOCK_EVENT_BURST=1 makes each PullMessages return one second's worth of the
 * observed flood, so client flood handling can be tested. Without it a pull
 * returns one motion event — a stand-in cadence, since only the peak rate was
 * measured on the hardware.
 */
export const persona = {
  name: 'ipm32r32p',
  defaults: { channels: 32 },
  create(ctx) {
    // ~485 events/minute observed ≈ 8/second; a burst pull returns one
    // second's worth, timestamped 125ms apart.
    const BURST_PER_PULL = 8;
    const BURST_SPACING_MS = 125;
    const burst = process.env.MOCK_EVENT_BURST === '1';
    let seq = 0;

    function messageXml(at, channel) {
      return '<wsnt:NotificationMessage>'
        + '<wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">tns1:RuleEngine/CellMotionDetector/Motion</wsnt:Topic>'
        + `<wsnt:Message><tt:Message UtcTime="${at.toISOString()}">`
        + `<tt:Source><tt:SimpleItem Name="Source" Value="Media${channel + 1}"/></tt:Source>`
        + `<tt:Data><tt:SimpleItem Name="IsMotion" Value="${seq % 2 === 0 ? 'true' : 'false'}"/></tt:Data>`
        + '</tt:Message></wsnt:Message></wsnt:NotificationMessage>';
    }

    function pullMessagesXml() {
      const count = burst ? BURST_PER_PULL : 1;
      const now = Date.now();
      const messages = [];
      for (let i = 0; i < count; i += 1) {
        messages.push(messageXml(new Date(now - (count - 1 - i) * BURST_SPACING_MS), seq % ctx.CHANNELS));
        seq += 1;
      }
      ctx.callCounts['events.delivered'] = (ctx.callCounts['events.delivered'] ?? 0) + count;
      return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:tt="http://www.onvif.org/ver10/schema">
<SOAP-ENV:Body><tev:PullMessagesResponse>
<tev:CurrentTime>${new Date(now).toISOString()}</tev:CurrentTime><tev:TerminationTime>${new Date(now + 60000).toISOString()}</tev:TerminationTime>
${messages.join('\n')}
</tev:PullMessagesResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
    }

    return {
      onSoap({ res, op, service }) {
        if (service === 'events' && op === 'PullMessages') {
          res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
          res.end(pullMessagesXml());
          return true;
        }
        return false;
      },
    };
  },
};
