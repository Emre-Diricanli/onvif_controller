/**
 * Registry for MOCK_PERSONA (GOVERNOR.md, Part 2). One module per probed
 * device; each documents what was observed on the hardware and implements
 * only that. A persona may declare `defaults` (env-mode values applied when
 * the matching MOCK_* variable is unset) and a `create(ctx)` returning hooks:
 *
 *   onRequest(req, res)                  raw HTTP, before built-in dispatch
 *   onSoap({ req, res, body, op, service })  per parsed SOAP request
 *
 * A hook answers by returning true. Unknown names fail loudly — a typo must
 * not silently run the wrong device.
 */
import { persona as ipm32r32p } from './ipm32r32p.js';
import { persona as rst08 } from './rst08.js';
import { persona as ar504 } from './ar504.js';
import { persona as nr520 } from './nr520.js';
import { persona as dahuaXvr } from './dahua-xvr.js';
import { persona as vatilon } from './vatilon.js';

const PERSONAS = { ipm32r32p, rst08, ar504, nr520, 'dahua-xvr': dahuaXvr, vatilon };

export function loadPersona(name) {
  const persona = PERSONAS[name];
  if (!persona) {
    console.error(`Unknown MOCK_PERSONA "${name}". Known personas: ${Object.keys(PERSONAS).join(', ')}`);
    process.exit(1);
  }
  return persona;
}
