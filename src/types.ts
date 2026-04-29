export type StructuredLog = {
  level: 'info' | 'warn' | 'error';
  message: string;
  hostname?: string;
  event_name?: string;
  site_id?: string;
  duration_ms?: number;
  error?: string;
  status?: number;
  [key: string]: unknown;
};

export function logStructured(log: StructuredLog): void {
  const fn =
    log.level === 'error' ? console.error : log.level === 'warn' ? console.warn : console.log;
  fn(JSON.stringify(log));
}
