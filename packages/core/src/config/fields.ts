import { toJSONSchema } from 'zod';
import { VeritasConfig } from './schema.js';

/** The kind of value a setting holds, which decides how an editor changes it. */
export type ConfigFieldType = 'boolean' | 'enum' | 'integer' | 'number' | 'string' | 'array' | 'fixed';

/** One leaf setting of the configuration, read from the schema: what it is, its default and what it accepts. */
export interface ConfigField {
  /** Keys from the top of the configuration, such as `['mutation', 'timeoutMs']`. */
  path: string[];
  type: ConfigFieldType;
  description: string;
  /** The value used when the setting is absent; `undefined` when it has none (the setting is then unset). */
  default: unknown;
  /** Whether `null` is accepted. */
  nullable: boolean;
  /** Whether the setting must be present once its parent object is written (it has no default of its own). */
  required: boolean;
  /** The allowed values of an enum. */
  options?: string[];
  /** The only value of a fixed setting. */
  fixed?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  pattern?: string;
  minItems?: number;
  /** What each element of an array holds. */
  items?: { type: 'string' | 'enum'; options?: string[]; pattern?: string };
}

/** A top-level group of settings (`''` for the top-level values such as `schemaVersion`). */
export interface ConfigSection {
  key: string;
  description: string;
  fields: ConfigField[];
}

interface Node {
  type?: string | string[];
  description?: string;
  default?: unknown;
  enum?: string[];
  const?: unknown;
  properties?: Record<string, Node>;
  required?: string[];
  items?: Node;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  pattern?: string;
  minItems?: number;
}

/** zod's int() adds the safe integer range; it is no real bound. */
const bound = (value: number | undefined) =>
  value === undefined || Math.abs(value) >= Number.MAX_SAFE_INTEGER ? undefined : value;

function field(node: Node, path: string[], inherited: unknown, required: boolean): ConfigField {
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  const main = types.find((t) => t !== 'null');
  const type: ConfigFieldType =
    node.const !== undefined
      ? 'fixed'
      : node.enum
        ? 'enum'
        : main === 'boolean' || main === 'integer' || main === 'number' || main === 'array'
          ? main
          : 'string';
  const out: ConfigField = {
    path,
    type,
    description: node.description ?? '',
    default: node.default !== undefined ? node.default : inherited,
    nullable: types.includes('null'),
    required,
  };
  const min = bound(node.minimum);
  const max = bound(node.maximum);

  if (node.enum) out.options = node.enum;
  if (node.const !== undefined) out.fixed = node.const;
  if (min !== undefined) out.minimum = min;
  if (max !== undefined) out.maximum = max;
  if (node.exclusiveMinimum !== undefined) out.exclusiveMinimum = node.exclusiveMinimum;
  if (node.pattern) out.pattern = node.pattern;
  if (node.minItems) out.minItems = node.minItems;
  if (type === 'array') {
    const items = node.items ?? {};

    out.items = items.enum
      ? { type: 'enum', options: items.enum }
      : { type: 'string', ...(items.pattern ? { pattern: items.pattern } : {}) };
  }

  return out;
}

function collect(node: Node, path: string[], inherited: unknown, required: boolean, out: ConfigField[]) {
  const own = node.default !== undefined ? node.default : inherited;

  if (node.type === 'object' && node.properties) {
    for (const [name, child] of Object.entries(node.properties)) {
      const value = own && typeof own === 'object' ? (own as Record<string, unknown>)[name] : undefined;

      collect(child, [...path, name], value, node.required?.includes(name) ?? false, out);
    }

    return;
  }
  out.push(field(node, path, inherited, required));
}

/**
 * Every setting of `.veritas/config.json`, grouped by its top-level key, with the descriptions, defaults and
 * constraints of the configuration schema. Editors show these instead of keeping their own copy.
 */
export function configSections(): ConfigSection[] {
  const schema = toJSONSchema(VeritasConfig, { io: 'input', unrepresentable: 'any' }) as Node;
  const top: ConfigField[] = [];
  const sections: ConfigSection[] = [];

  for (const [name, node] of Object.entries(schema.properties ?? {})) {
    if (node.type === 'object' && node.properties) {
      const fields: ConfigField[] = [];

      collect(node, [name], undefined, false, fields);
      sections.push({ key: name, description: node.description ?? '', fields });
    } else top.push(field(node, [name], undefined, false));
  }

  return [{ key: '', description: 'Format of this file.', fields: top }, ...sections];
}
