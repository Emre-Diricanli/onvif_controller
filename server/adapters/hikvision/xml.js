/**
 * Just enough XML for ISAPI, without a dependency (SPEC.md: no new npm deps).
 *
 * ISAPI documents are shallow, element-only, and namespaced by a default
 * xmlns, so a namespace-agnostic tag matcher is sufficient. Edits are done
 * IN PLACE on the device's own document: ISAPI PUT replaces the whole node,
 * so the safe write is "GET the device's XML, change only the requested
 * elements' text, PUT that exact document back" — every element we did not
 * model (and there are many, varying by firmware) survives untouched.
 */

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };

export function decode(text) {
  return String(text).replace(/&(lt|gt|amp|quot|apos);/g, (m) => ENTITIES[m]);
}

export function encode(value) {
  return String(value).replace(/[<>&"']/g, (ch) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
}

/** `<prefix:tag attr="…">` open-tag pattern, prefix optional. */
const open = (tag) => `<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>`;
const close = (tag) => `</(?:[\\w-]+:)?${tag}>`;

/** Every <tag>…</tag> block (outer XML) in document order. */
export function blocks(xml, tag) {
  const re = new RegExp(`${open(tag)}[\\s\\S]*?${close(tag)}`, 'g');
  return String(xml ?? '').match(re) ?? [];
}

export function block(xml, tag) {
  return blocks(xml, tag)[0] ?? null;
}

/** Text of the first <tag>, or null. Only for leaf elements. */
export function text(xml, tag) {
  const m = new RegExp(`${open(tag)}([^<]*)${close(tag)}`).exec(String(xml ?? ''));
  return m ? decode(m[1].trim()) : null;
}

/** Attribute of the first <tag …>, or null (capabilities carry opt/min/max). */
export function attr(xml, tag, name) {
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}\\s[^>]*\\b${name}="([^"]*)"`).exec(String(xml ?? ''));
  return m ? decode(m[1]) : null;
}

/**
 * Replace the text of the first leaf <tag> inside the first <scope> block
 * (or the whole document when scope is null). Returns null when the element
 * is absent — the caller must not invent an element the firmware never sent.
 */
export function setText(xml, tag, value, scope = null) {
  const doc = String(xml);
  const container = scope ? block(doc, scope) : doc;
  if (container === null) return null;
  const re = new RegExp(`(${open(tag)})[^<]*(${close(tag)})`);
  if (!re.test(container)) return null;
  const edited = container.replace(re, (_m, a, b) => `${a}${encode(value)}${b}`);
  return scope ? doc.replace(container, edited) : edited;
}

/** ISAPI <ResponseStatus>: statusCode 1 is OK; anything else is a refusal. */
export function responseStatus(xml) {
  const status = block(xml, 'ResponseStatus');
  if (!status) return null;
  return {
    code: Number(text(status, 'statusCode')),
    message: text(status, 'statusString'),
    subCode: text(status, 'subStatusCode'),
  };
}
