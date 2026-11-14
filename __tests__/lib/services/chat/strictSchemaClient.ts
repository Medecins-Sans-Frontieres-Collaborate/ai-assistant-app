/**
 * A fake OpenAI client for routing tests whose replies behave like a strict
 * json_schema model: tests hand-write only the fields they care about and
 * the rest of the schema is filled with neutral values. Routing decisions
 * are validated against their schema on every path (as in production), so
 * a raw partial reply would be rejected.
 */
import type OpenAI from 'openai';

/**
 * Shapes a hand-written decision the way a strict json_schema model replies:
 * keys the schema does not declare are dropped and missing properties get a
 * neutral value, while every value the test chose is kept as-is. Tests write
 * only the fields they care about; the router is still held to the same
 * schema validation production applies.
 */
export function conformToSchema(value: unknown, schema: any): unknown {
  if (!schema || typeof schema !== 'object') return value;
  const type = Array.isArray(schema.type)
    ? schema.type.find((entry: string) => entry !== 'null')
    : schema.type;
  if (type === 'object') {
    const source =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const result: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(schema.properties ?? {}))
      result[key] =
        key in source
          ? conformToSchema(source[key], property)
          : neutralValue(property);
    return result;
  }
  if (type === 'array' && Array.isArray(value))
    return value.map((item) => conformToSchema(item, schema.items));
  return value;
}

function neutralValue(schema: any): unknown {
  if (Array.isArray(schema?.enum)) return schema.enum[0];
  const types: string[] = Array.isArray(schema?.type)
    ? schema.type
    : [schema?.type];
  if (types.includes('null')) return null;
  switch (types[0]) {
    case 'boolean':
      return false;
    case 'number':
    case 'integer':
      return 0;
    case 'string':
      return '';
    case 'array':
      return [];
    case 'object':
      return conformToSchema({}, schema);
    default:
      return null;
  }
}

/** Wraps the test's mock so replies conform to the request's schema. */
export function strictSchemaClient(mock: any): OpenAI {
  return {
    chat: {
      completions: {
        create: async (params: any, options?: unknown) => {
          const reply = await mock.chat.completions.create(params, options);
          const schema = params?.response_format?.json_schema?.schema;
          const content = reply?.choices?.[0]?.message?.content;
          if (!schema || typeof content !== 'string') return reply;
          let parsed: unknown;
          try {
            parsed = JSON.parse(content);
          } catch {
            return reply;
          }
          return {
            ...reply,
            choices: [
              {
                ...reply.choices[0],
                message: {
                  ...reply.choices[0].message,
                  content: JSON.stringify(conformToSchema(parsed, schema)),
                },
              },
            ],
          };
        },
      },
    },
  } as unknown as OpenAI;
}
