import type { BrowserAdapter } from '@techie-mind/browser';
import { HISTORY_STORAGE_KEY, TaskResult } from '@techie-mind/contracts';
import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../ui/icons.js';

function parseHistory(value: unknown): TaskResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = TaskResult.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function useHistory(adapter: BrowserAdapter): TaskResult[] {
  const [items, setItems] = useState<TaskResult[]>([]);
  useEffect(() => {
    let active = true;
    void adapter.storageGet(HISTORY_STORAGE_KEY).then((v) => active && setItems(parseHistory(v)));
    const off = adapter.onStorageChange(
      HISTORY_STORAGE_KEY,
      (v) => active && setItems(parseHistory(v)),
    );
    return () => {
      active = false;
      off();
    };
  }, [adapter]);
  return items;
}

const STATUS: Record<string, string> = {
  COMPLETED: 'completed',
  FAILED: 'error',
  HUMAN_REQUIRED: 'needs you',
};

export function HistoryView(props: { adapter: BrowserAdapter; onRerun: (text: string) => void }) {
  const items = useHistory(props.adapter);
  return (
    <section class="tm-page" data-testid="history-view">
      <div class="tm-page-head">
        <h2>History</h2>
        <button
          type="button"
          class="tm-btn-ghost"
          disabled={items.length === 0}
          onClick={() => void props.adapter.storageSet(HISTORY_STORAGE_KEY, [])}
        >
          Clear all
        </button>
      </div>
      {items.length === 0 ? (
        <div class="tm-empty">
          <Icon name="clock" size={28} />
          <p>No tasks yet.</p>
          <small>Completed and failed tasks appear here with their steps and errors.</small>
        </div>
      ) : (
        <div class="tm-history">
          {items.map((item) => (
            <article class="tm-history-item" key={item.taskId} data-testid="history-item">
              <p class="tm-history-text">{item.text}</p>
              {item.error ? <p class="tm-history-error">{item.error.message}</p> : null}
              <div class="tm-history-meta">
                <span>
                  {STATUS[item.status] ?? item.status} · {item.steps.length} steps ·{' '}
                  {new Date(item.startedAt).toLocaleString([], {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span class="tm-history-actions">
                  <button
                    type="button"
                    class="tm-btn-ghost"
                    onClick={() => void navigator.clipboard?.writeText(item.text)}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    class="tm-btn-ghost"
                    onClick={() => props.onRerun(item.text)}
                  >
                    Rerun
                  </button>
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
