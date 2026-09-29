import {
  customSkillId,
  MODEL_SKILLS,
  SKILL_EXAMPLES,
  SKILLS,
  validateCustomSkill,
} from '@techie-mind/agent-core';
import type { BrowserAdapter } from '@techie-mind/browser';
import {
  EMPTY_SKILLS_CONFIG,
  SkillId,
  type CustomSkill,
  type SkillsConfig,
} from '@techie-mind/contracts';
import { SUMMARIZE_SYSTEM } from '@techie-mind/models';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { loadSkills, saveSkills } from '../shared/skills-store.js';

/**
 * Settings → Skills (reference UI: "Skills & Injected Instructions"). Every skill opens to show
 * what it does, how to say it, its inputs, safety, verification and failure handling. Skills whose
 * output the local model writes take the user's own instructions (added after the fixed rules).
 * "+ New Skill" makes the user's own skill: steps written as ordinary commands, checked as typed.
 */

const ICONS: Record<SkillId, string> = {
  'summarize-page': '📄',
  'deep-research': '🔬',
  'extract-data': '📊',
  'compare-prices': '🛒',
  'fill-form': '📝',
  'find-alternatives': '🔄',
  'manage-bookmarks': '🔖',
  'monitor-page': '👁️',
  'organize-tabs': '🗂️',
  'read-later': '📚',
  'save-page': '💾',
  'screenshot-walkthrough': '📸',
};

const BLURBS: Record<SkillId, string> = {
  'summarize-page': 'Summarize the page you are on. Text-first, local extraction first.',
  'deep-research': 'Multi-source investigation with explicit citations.',
  'extract-data': 'Turn the current page into structured, export-ready data.',
  'compare-prices': 'Cross-store price comparison, every price read from the store itself.',
  'fill-form': 'Safe form completion from your profile. Never submits.',
  'find-alternatives': 'Discover and vet replacement options for a product.',
  'manage-bookmarks': 'Add, search and remove bookmarks through Chrome itself.',
  'monitor-page': 'Watch a product and remember the price you are waiting for.',
  'organize-tabs': 'Clean up tab chaos: group by site, close duplicates on request.',
  'read-later': 'Queue pages for later reading and recall them on demand.',
  'save-page': 'Save the current page as a Markdown file you keep offline.',
  'screenshot-walkthrough': 'A screenshot with numbered steps; personal data painted over.',
};

const RISK_TEXT: Record<string, string> = {
  LOW: 'Low — reads or organizes; changes nothing on websites',
  MEDIUM: 'Medium — navigates or types for you, verified after every step',
  HIGH: 'High — asks you before it acts',
  HUMAN_REQUIRED: 'Always handed to you',
  BLOCKED: 'Blocked',
};

type View =
  | { kind: 'grid' }
  | { kind: 'builtin'; id: SkillId }
  | { kind: 'edit'; draft: Draft; isNew: boolean };

interface Draft {
  id: string;
  icon: string;
  name: string;
  description: string;
  triggers: string;
  steps: string;
  createdAt: number;
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function toDraft(skill: CustomSkill): Draft {
  return {
    id: skill.id,
    icon: skill.icon,
    name: skill.name,
    description: skill.description,
    triggers: skill.triggers.join('\n'),
    steps: skill.steps.join('\n'),
    createdAt: skill.createdAt,
  };
}

function fromDraft(d: Draft): CustomSkill {
  return {
    id: d.id,
    icon: d.icon.trim().slice(0, 8),
    name: d.name.trim(),
    description: d.description.trim(),
    triggers: lines(d.triggers),
    steps: lines(d.steps),
    createdAt: d.createdAt,
  };
}

type Status = { kind: 'idle' } | { kind: 'saved'; text: string } | { kind: 'error'; text: string };

export function SkillsSection({ adapter }: { adapter: BrowserAdapter }) {
  const [config, setConfig] = useState<SkillsConfig>(EMPTY_SKILLS_CONFIG);
  const [view, setView] = useState<View>({ kind: 'grid' });
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  useEffect(() => {
    void loadSkills(adapter).then(setConfig);
  }, [adapter]);

  const persist = async (next: SkillsConfig, text: string) => {
    const result = await saveSkills(adapter, next);
    if (result.ok) {
      setConfig(next);
      setStatus({ kind: 'saved', text });
      return true;
    }
    setStatus({ kind: 'error', text: `Not saved — ${result.message}` });
    return false;
  };

  const open = (next: View) => {
    setStatus({ kind: 'idle' });
    setView(next);
  };

  if (view.kind === 'builtin') {
    return (
      <BuiltInDetail
        key={view.id}
        id={view.id}
        instructions={config.instructions[view.id] ?? ''}
        status={status}
        onBack={() => open({ kind: 'grid' })}
        onSave={(text) =>
          persist(
            { ...config, instructions: { ...config.instructions, [view.id]: text.trim() } },
            text.trim() ? 'Saved — used from the next task' : 'Cleared',
          )
        }
      />
    );
  }

  if (view.kind === 'edit') {
    return (
      <CustomEditor
        key={`${view.draft.id}:${view.isNew}`}
        draft={view.draft}
        isNew={view.isNew}
        others={config.custom}
        status={status}
        onBack={() => open({ kind: 'grid' })}
        onSave={async (skill) => {
          const exists = config.custom.some((c) => c.id === skill.id);
          const custom = exists
            ? config.custom.map((c) => (c.id === skill.id ? skill : c))
            : [...config.custom, skill];
          if (await persist({ ...config, custom }, `Saved "${skill.name}"`)) {
            setView({ kind: 'edit', draft: toDraft(skill), isNew: false });
          }
        }}
        onDelete={async (id) => {
          const ok = await persist(
            { ...config, custom: config.custom.filter((c) => c.id !== id) },
            'Deleted',
          );
          if (ok) setView({ kind: 'grid' });
        }}
      />
    );
  }

  return (
    <>
      <header class="tm-page-header tm-skills-header">
        <div>
          <h1>Skills &amp; Injected Instructions</h1>
          <p>
            Inspect every skill, add your own instructions where a model writes the result, and make
            your own skills from commands Techie Mind already understands.
          </p>
        </div>
        <button
          type="button"
          class="tm-btn-save"
          data-testid="new-skill"
          onClick={() =>
            open({
              kind: 'edit',
              isNew: true,
              draft: {
                id: '',
                icon: '⚡',
                name: '',
                description: '',
                triggers: '',
                steps: '',
                createdAt: Date.now(),
              },
            })
          }
        >
          + New Skill
        </button>
      </header>

      <div class="tm-skill-grid">
        {SkillId.options.map((id) => (
          <button
            type="button"
            class="tm-skill"
            key={id}
            data-testid={`skill-${id}`}
            onClick={() => open({ kind: 'builtin', id })}
          >
            <div class="tm-skill-head">
              <strong>
                <span aria-hidden="true">{ICONS[id]}</span> {SKILLS[id].name}
              </strong>
              <span class="tm-tag tm-tag-builtin">BUILT-IN</span>
            </div>
            <p>{BLURBS[id]}</p>
            <span class="tm-skill-link">
              {MODEL_SKILLS.has(id) ? 'Inspect & Edit Prompt' : 'Inspect'} ›
              {config.instructions[id]?.trim() ? (
                <em class="tm-skill-flag"> · your instructions on</em>
              ) : null}
            </span>
          </button>
        ))}
      </div>

      <h2 class="tm-skills-sub">Your skills</h2>
      {config.custom.length === 0 ? (
        <p class="tm-muted" data-testid="no-custom-skills">
          None yet. Use <strong>+ New Skill</strong> to turn a few commands you often type into one
          sentence — for example “laptop deals under {'{input}'}”.
        </p>
      ) : (
        <div class="tm-skill-grid">
          {config.custom.map((skill) => (
            <button
              type="button"
              class="tm-skill"
              key={skill.id}
              data-testid={`custom-${skill.id}`}
              onClick={() => open({ kind: 'edit', draft: toDraft(skill), isNew: false })}
            >
              <div class="tm-skill-head">
                <strong>
                  <span aria-hidden="true">{skill.icon}</span> {skill.name}
                </strong>
                <span class="tm-tag tm-tag-custom">CUSTOM</span>
              </div>
              <p>{skill.description || `Say “${skill.triggers[0]}”`}</p>
              <span class="tm-skill-link">
                {skill.steps.length} step{skill.steps.length === 1 ? '' : 's'} · Edit ›
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function StatusLine({ status }: { status: Status }) {
  return (
    <span
      role="status"
      data-testid="skill-status"
      class={`tm-save-${status.kind === 'error' ? 'error' : 'saved'}`}
    >
      {status.kind === 'idle' ? '' : status.text}
    </span>
  );
}

function BuiltInDetail(props: {
  id: SkillId;
  instructions: string;
  status: Status;
  onBack: () => void;
  onSave: (text: string) => void;
}) {
  const skill = SKILLS[props.id];
  const [text, setText] = useState(props.instructions);
  const model = MODEL_SKILLS.has(props.id);
  return (
    <div class="tm-skill-detail" data-testid="skill-detail">
      <button type="button" class="tm-back" data-testid="back-to-skills" onClick={props.onBack}>
        ‹ All skills
      </button>
      <header class="tm-page-header">
        <h1>
          <span aria-hidden="true">{ICONS[props.id]}</span> {skill.name}{' '}
          <span class="tm-tag tm-tag-builtin">BUILT-IN</span>
        </h1>
        <p>{skill.description}</p>
      </header>

      <section class="tm-panel">
        <h2>How to use it</h2>
        <p class="tm-muted">Type any of these in the side panel (or its slash command):</p>
        <div class="tm-chips" data-testid="skill-examples">
          {SKILL_EXAMPLES[props.id].map((e) => (
            <code key={e} class="tm-chip">
              {e}
            </code>
          ))}
          <code class="tm-chip">/{props.id}</code>
        </div>
      </section>

      <section class="tm-panel">
        <h2>Inputs</h2>
        {skill.inputs.length === 0 ? (
          <p class="tm-muted">None — it works on the page you have open.</p>
        ) : (
          <ul class="tm-plain-list">
            {skill.inputs.map((i) => (
              <li key={i.name}>
                <strong>{i.name}</strong> {i.required ? '(required)' : '(optional)'} —{' '}
                {i.description}
                {i.options ? ` · ${i.options.join(', ')}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section class="tm-panel">
        <h2>Safety</h2>
        <ul class="tm-plain-list">
          <li>
            <strong>Risk:</strong> {RISK_TEXT[skill.riskLevel] ?? skill.riskLevel}
          </li>
          <li>
            <strong>Asks before acting:</strong> {skill.requiresConfirmation ? 'yes' : 'no'}
          </li>
          <li>
            <strong>Browser permissions used:</strong> {skill.permissions.join(', ') || 'none'}
          </li>
          <li>
            Every action still passes the local firewall; payments, OTPs and CAPTCHAs are always
            handed to you.
          </li>
        </ul>
      </section>

      <section class="tm-panel">
        <h2>Verification checklist</h2>
        <p data-testid="skill-verification">{skill.verification}</p>
        <h2>If it fails</h2>
        <p>{skill.failureHandling}</p>
      </section>

      <section class="tm-panel" data-testid="skill-prompt">
        <h2>Prompt</h2>
        {model ? (
          <>
            <p class="tm-muted">
              The local model writes this skill's result. These rules are fixed and always applied
              first:
            </p>
            <pre class="tm-prompt">{SUMMARIZE_SYSTEM}</pre>
            <label for="skill-instructions" class="tm-field-label">
              Your instructions (optional)
            </label>
            <textarea
              id="skill-instructions"
              class="tm-text tm-textarea"
              data-testid="skill-instructions"
              maxLength={500}
              rows={3}
              placeholder="e.g. Keep it to 3 bullets in simple English. Mention prices if there are any."
              value={text}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            />
            <small class="tm-muted">
              Added after the fixed rules for this skill only. They shape style and focus; they
              can't switch off privacy rules. {500 - text.length} characters left.
            </small>
            <div class="tm-savebar">
              <StatusLine status={props.status} />
              <button
                type="button"
                class="tm-btn-save"
                data-testid="skill-instructions-save"
                onClick={() => props.onSave(text)}
              >
                Save instructions
              </button>
            </div>
          </>
        ) : (
          <p data-testid="skill-no-prompt">
            This skill runs entirely in code on your device — no model prompt is involved, so there
            is nothing to edit. It follows the checklist above.
          </p>
        )}
      </section>
    </div>
  );
}

function CustomEditor(props: {
  draft: Draft;
  isNew: boolean;
  others: readonly CustomSkill[];
  status: Status;
  onBack: () => void;
  onSave: (skill: CustomSkill) => void;
  onDelete: (id: string) => void;
}) {
  const [d, setD] = useState<Draft>(props.draft);
  const skill = useMemo(() => {
    const s = fromDraft(d);
    return props.isNew
      ? {
          ...s,
          id: customSkillId(
            s.name || 'skill',
            props.others.map((o) => o.id),
          ),
        }
      : s;
  }, [d, props.isNew, props.others]);
  const issues = useMemo(() => validateCustomSkill(skill, props.others), [skill, props.others]);
  // Update from the latest state: quick edits in several fields must not overwrite each other.
  const set = (key: keyof Draft) => (e: Event) => {
    const value = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
    setD((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div class="tm-skill-detail" data-testid="custom-editor">
      <button type="button" class="tm-back" data-testid="back-to-skills" onClick={props.onBack}>
        ‹ All skills
      </button>
      <header class="tm-page-header">
        <h1>
          {props.isNew ? 'New skill' : d.name || 'Skill'}{' '}
          <span class="tm-tag tm-tag-custom">CUSTOM</span>
        </h1>
        <p>
          A skill of your own is a shortcut: one sentence that runs a few commands you already type.
          Each step runs exactly as if you typed it — same safety checks, and it stops at the first
          step that doesn't work.
        </p>
      </header>

      <section class="tm-panel">
        <div class="tm-row">
          <div class="tm-field tm-field-icon">
            <label for="custom-icon">Icon</label>
            <input
              id="custom-icon"
              class="tm-text"
              maxLength={8}
              value={d.icon}
              onInput={set('icon')}
            />
          </div>
          <div class="tm-field tm-grow">
            <label for="custom-name">Name</label>
            <input
              id="custom-name"
              class="tm-text"
              data-testid="custom-name"
              maxLength={40}
              placeholder="Laptop deals"
              value={d.name}
              onInput={set('name')}
            />
          </div>
        </div>
        <div class="tm-field">
          <label for="custom-description">What it does (optional)</label>
          <input
            id="custom-description"
            class="tm-text"
            maxLength={200}
            placeholder="Cheapest laptop under my budget on Flipkart"
            value={d.description}
            onInput={set('description')}
          />
        </div>
        <div class="tm-field">
          <label for="custom-triggers">Say it like — one sentence per line</label>
          <textarea
            id="custom-triggers"
            class="tm-text tm-textarea"
            data-testid="custom-triggers"
            rows={3}
            placeholder={'laptop deals under {input}\nfind me a cheap laptop'}
            value={d.triggers}
            onInput={set('triggers')}
          />
          <small>
            Put <code>{'{input}'}</code> where your own words go: “laptop deals under ₹40,000” fills{' '}
            <code>{'{input}'}</code> with “₹40,000”.
          </small>
        </div>
        <div class="tm-field">
          <label for="custom-steps">
            Steps — one command per line, as you'd type it in the panel
          </label>
          <textarea
            id="custom-steps"
            class="tm-text tm-textarea"
            data-testid="custom-steps"
            rows={5}
            placeholder={'search laptops under {input} on Flipkart\nopen the cheapest one'}
            value={d.steps}
            onInput={set('steps')}
          />
          <small>Up to 10 steps. Steps can't buy anything or start another custom skill.</small>
        </div>

        {issues.length > 0 && (d.name || d.triggers || d.steps) ? (
          <ul class="tm-issues" role="alert" data-testid="custom-issues">
            {issues.map((i) => (
              <li key={i.message}>{i.message}</li>
            ))}
          </ul>
        ) : null}
        {issues.length === 0 ? (
          <p class="tm-ok" data-testid="custom-ok">
            ✓ Every step is a command Techie Mind understands.
          </p>
        ) : null}

        <div class="tm-savebar">
          <StatusLine status={props.status} />
          {!props.isNew ? (
            <button
              type="button"
              class="tm-btn-outline"
              data-testid="custom-delete"
              onClick={() => props.onDelete(d.id)}
            >
              Delete
            </button>
          ) : null}
          <button
            type="button"
            class="tm-btn-save"
            data-testid="custom-save"
            disabled={issues.length > 0}
            onClick={() => props.onSave(skill)}
          >
            Save skill
          </button>
        </div>
      </section>
    </div>
  );
}
