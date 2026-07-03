// Capability registry: each capability declares a stable input/output schema.
// Schemas are stable across providers — switching who serves a task never
// changes its shape. Types: string | number | integer | object; trailing "?"
// marks a field optional.

export const CAPABILITIES = {
  'text.generate': {
    description: 'Generate text from a prompt',
    input: { prompt: 'string' },
    output: { text: 'string' },
    primary: 'text',
  },
  'image.generate': {
    description: 'Generate an image from a prompt, returns a URL',
    input: { prompt: 'string', width: 'integer?', height: 'integer?' },
    output: { url: 'string' },
    primary: 'url',
  },
  'text.summarize': {
    description: 'Condense a document into a short summary',
    input: { text: 'string' },
    output: { summary: 'string' },
    primary: 'summary',
  },
  'audio.speak': {
    description: 'Text to speech, returns an audio URL',
    input: { text: 'string', voice: 'string?' },
    output: { url: 'string' },
    primary: 'url',
  },
  'embed.text': {
    description: 'Vector embeddings for retrieval and search',
    input: { text: 'string' },
    output: { vector: 'object' },
    primary: 'vector',
  },
  'math.eval': {
    description: 'Evaluate an arithmetic expression exactly',
    input: { expression: 'string' },
    output: { result: 'number' },
    primary: 'result',
  },
  // In the catalog but served by no seeded provider — posting against it
  // demonstrates the 409 no_quotes path.
  'research.web': {
    description: 'Answer a question with cited web research',
    input: { question: 'string' },
    output: { text: 'string' },
    primary: 'text',
  },
};

const typeOk = (val, type) => {
  switch (type) {
    case 'string': return typeof val === 'string';
    case 'number': return typeof val === 'number' && Number.isFinite(val);
    case 'integer': return Number.isInteger(val);
    case 'object': return val !== null && typeof val === 'object';
    default: return false;
  }
};

function validate(schema, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, detail: 'payload must be a JSON object' };
  }
  for (const [field, spec] of Object.entries(schema)) {
    const optional = spec.endsWith('?');
    const type = optional ? spec.slice(0, -1) : spec;
    const present = value[field] !== undefined;
    if (!present) {
      if (optional) continue;
      return { ok: false, detail: `missing required field "${field}" (${type})` };
    }
    if (!typeOk(value[field], type)) {
      return { ok: false, detail: `field "${field}" must be ${type}` };
    }
  }
  return { ok: true };
}

export const validateInput = (capability, input) =>
  validate(CAPABILITIES[capability].input, input);

export const validateOutput = (capability, output) =>
  validate(CAPABILITIES[capability].output, output);

// The field verification and graders treat as "the deliverable".
export const primaryValue = (capability, output) =>
  output?.[CAPABILITIES[capability].primary];
