const READ_OPERATIONS = new Set(['read', 'database_read', 'query']);
const WRITE_OPERATIONS = new Set(['write', 'database_write', 'mutate']);
const ENVELOPE_KEYS = new Set(['operation', 'kind', 'command', 'tool', 'name', 'payload', 'args', 'arguments']);

type DatabaseOperation = 'read' | 'write';
type CommandPayload = Record<string, unknown>;

interface NormalizedDatabaseCommand {
  operation: DatabaseOperation;
  payload: unknown;
}

interface DatabaseCommandService {
  read(payload: unknown, contextOverride?: unknown): unknown;
  write(payload: unknown, contextOverride?: unknown): unknown;
}

function isObject(value: unknown): value is CommandPayload {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeDatabaseOperation(value: unknown, fallback: unknown = 'read'): DatabaseOperation {
  const raw = String(value || fallback || 'read').trim();
  if (READ_OPERATIONS.has(raw)) return 'read';
  if (WRITE_OPERATIONS.has(raw)) return 'write';
  throw new Error(`Unknown database operation: ${raw}`);
}

function hasEnvelopeOperation(source: CommandPayload): boolean {
  return Boolean(source.operation || source.kind || source.command || source.tool || source.name);
}

function operationFromEnvelope(source: CommandPayload, fallback: unknown): DatabaseOperation {
  return normalizeDatabaseOperation(
    source.operation || source.kind || source.command || source.tool || source.name,
    fallback
  );
}

function payloadFromEnvelope(source: CommandPayload): unknown {
  if (isObject(source.payload)) return source.payload;
  if (hasEnvelopeOperation(source) && isObject(source.arguments)) return source.arguments;
  if (hasEnvelopeOperation(source) && isObject(source.args)) return source.args;

  if (hasEnvelopeOperation(source)) {
    const payload: CommandPayload = {};
    for (const [key, value] of Object.entries(source)) {
      if (!ENVELOPE_KEYS.has(key)) payload[key] = value;
    }
    if (Object.keys(payload).length > 0) return payload;
  }

  return source;
}

export function normalizeDatabaseCommand(command: unknown = {}, fallbackOperation: unknown = 'read'): NormalizedDatabaseCommand {
  const source = isObject(command) ? command : {};
  return {
    operation: operationFromEnvelope(source, fallbackOperation),
    payload: payloadFromEnvelope(source)
  };
}

export async function runDatabaseCommand(
  database: DatabaseCommandService | null | undefined,
  command: unknown = {},
  fallbackOperation: unknown = 'read',
  contextOverride: unknown = null
) {
  if (!database || typeof database.read !== 'function' || typeof database.write !== 'function') {
    throw new Error('database command requires a database service');
  }
  const normalized = normalizeDatabaseCommand(command, fallbackOperation);
  if (normalized.operation === 'read') return database.read(normalized.payload, contextOverride);
  if (normalized.operation === 'write') return database.write(normalized.payload, contextOverride);
  throw new Error(`Unhandled database operation: ${normalized.operation}`);
}
