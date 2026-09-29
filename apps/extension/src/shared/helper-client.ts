/**
 * Talks to the Techie Mind helper on this Mac (Chrome native messaging, scripts/helper), which can
 * only start, stop or report Laya and the local voice server. Chrome only.
 */
export type LocalService = 'laya' | 'whisper';

export interface ServiceState {
  /** The helper answered (it is installed). */
  installed: boolean;
  running: boolean;
  message: string;
}

const HOST = 'com.techiemind.helper';

interface NativeRuntime {
  id: string;
  lastError?: { message?: string };
  sendNativeMessage?: (host: string, message: unknown, callback: (reply: unknown) => void) => void;
}

function runtime(): NativeRuntime | null {
  const chrome = (globalThis as { chrome?: { runtime?: NativeRuntime } }).chrome;
  return chrome?.runtime?.sendNativeMessage ? chrome.runtime : null;
}

/** The one-time install command, with this extension's id. */
export function helperInstallCommand(): string {
  const id = runtime()?.id ?? '<extension-id>';
  return `cd ~/Developer/"new techy" && sh scripts/helper/install.sh ${id}`;
}

export function controlService(
  service: LocalService,
  cmd: 'status' | 'start' | 'stop',
): Promise<ServiceState> {
  const rt = runtime();
  if (!rt) {
    return Promise.resolve({
      installed: false,
      running: false,
      message: 'Switching services needs Chrome.',
    });
  }
  return new Promise((resolve) => {
    rt.sendNativeMessage!(HOST, { cmd, service }, (reply) => {
      const error = rt.lastError?.message;
      if (error || !reply || typeof reply !== 'object') {
        resolve({
          installed: false,
          running: false,
          message: error?.includes('not found')
            ? 'The helper is not installed yet (one-time command below).'
            : (error ?? 'The helper did not answer.'),
        });
        return;
      }
      const r = reply as { ok?: boolean; running?: boolean; message?: string };
      resolve({
        installed: true,
        running: Boolean(r.running),
        message: typeof r.message === 'string' ? r.message.slice(0, 300) : '',
      });
    });
  });
}
