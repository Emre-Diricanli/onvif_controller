/**
 * The small toolkit every MCP tool module uses (MCP.md §3).
 *
 * One definition shape, one way to build results, one error type, so the core
 * can register, gate and map every tool identically.
 */

export class ToolError extends Error {
  constructor(code, message, hint = null) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.hint = hint;
  }
}

export const text = (value) => ({ type: 'text', text: String(value) });
export const json = (value) => text(JSON.stringify(value, null, 2));
export const image = (buffer, mimeType = 'image/jpeg') => ({
  type: 'image',
  data: Buffer.from(buffer).toString('base64'),
  mimeType,
});

/** result(text('a'), [json(b), image(c)]): blocks may be nested arrays. */
export function result(...blocks) {
  return { content: blocks.flat(Infinity).filter(Boolean) };
}

const SECRET_PATTERNS = [
  /(rtsps?|https?):\/\/[^\s/@]*@/gi,               // credentialed URLs
  /(authorization|password|passwd|pwd|token)(["'\s:=]+)[^\s"',}]+/gi,
];

/** Belt and braces: nothing that looks like a credential leaves in an error. */
export function scrub(value) {
  let out = String(value ?? '');
  out = out.replace(SECRET_PATTERNS[0], '$1://***@');
  out = out.replace(SECRET_PATTERNS[1], '$1$2***');
  return out;
}

export function errorResult(err) {
  const code = err?.code ?? 'INTERNAL';
  const message = scrub(err?.message ?? 'The tool failed.');
  const hint = err?.hint ? `\nHint: ${scrub(err.hint)}` : '';
  return { isError: true, content: [text(`${code}: ${message}${hint}`)] };
}

const NAME = /^[a-z][a-z0-9_]*$/;

export function defineTool(def) {
  if (!def || typeof def !== 'object') throw new Error('defineTool needs a definition object');
  if (!NAME.test(def.name ?? '')) throw new Error(`Tool name "${def.name}" must be snake_case`);
  if (typeof def.description !== 'string' || def.description.length < 20) {
    throw new Error(`Tool "${def.name}" needs a real description (MCP.md §3)`);
  }
  if (typeof def.handler !== 'function') throw new Error(`Tool "${def.name}" has no handler`);
  if (def.inputSchema && (typeof def.inputSchema !== 'object' || typeof def.inputSchema.parse === 'function')) {
    throw new Error(`Tool "${def.name}": inputSchema must be a zod raw shape, not a z.object`);
  }
  const annotations = { openWorldHint: true, ...(def.annotations ?? {}) };
  if (annotations.readOnlyHint && annotations.destructiveHint) {
    throw new Error(`Tool "${def.name}" cannot be both readOnly and destructive`);
  }
  return { ...def, inputSchema: def.inputSchema ?? {}, annotations };
}
