import {
  AUDIT_STORAGE_KEY,
  ConsoleSink,
  createLogger,
  MemorySink,
  PersistentAuditLog,
  type StoredAudit,
} from '@techie-mind/telemetry';
import { getPlatform } from '../platform.js';
import { createBackgroundHandler } from './handler.js';
import { ExtensionHost } from './host.js';
import { startTaskService } from './tasks.js';

const startedAt = Date.now();
const adapter = getPlatform();
const logger = createLogger({
  component: 'background',
  sinks: [new MemorySink(), new ConsoleSink()],
  level: 'warn',
});

adapter.onMessage(createBackgroundHandler({ adapter, logger, startedAt }));
const audit = new PersistentAuditLog({
  get: () => adapter.storageGet(AUDIT_STORAGE_KEY),
  set: (value: StoredAudit) => adapter.storageSet(AUDIT_STORAGE_KEY, value),
});
startTaskService({ adapter, host: new ExtensionHost(adapter), logger, audit });

adapter.enablePanelOnActionClick().catch((err: unknown) => {
  logger.event('SYSTEM', 'could not bind the panel to the toolbar button', {
    level: 'error',
    data: { error: err instanceof Error ? err.message : String(err) },
  });
});
