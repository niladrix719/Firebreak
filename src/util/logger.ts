import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const pretty = process.env.NODE_ENV !== 'production' && process.stdout.isTTY;

export const logger = pino({
  level,
  // MCP speaks JSON-RPC on stdout; anything we print there corrupts the stream.
  ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, destination: 2 } } } : {}),
  redact: {
    paths: ['token', '*.token', 'apiKey', '*.apiKey', 'headers.authorization'],
    censor: '[redacted]',
  },
}, pretty ? undefined : pino.destination(2));

export type Logger = typeof logger;
