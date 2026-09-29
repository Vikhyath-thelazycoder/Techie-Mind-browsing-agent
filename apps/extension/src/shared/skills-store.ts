import type { BrowserAdapter } from '@techie-mind/browser';
import { EMPTY_SKILLS_CONFIG, SKILLS_STORAGE_KEY, SkillsConfig } from '@techie-mind/contracts';

/**
 * The user's skill settings (Settings → Skills), stored locally in this browser: instructions for
 * model-written skills and the user's own skills. Anything that does not match the contract is
 * ignored (never half-used), so a damaged value simply means "no custom skills".
 */
export async function loadSkills(adapter: BrowserAdapter): Promise<SkillsConfig> {
  try {
    const parsed = SkillsConfig.safeParse(await adapter.storageGet(SKILLS_STORAGE_KEY));
    return parsed.success ? parsed.data : EMPTY_SKILLS_CONFIG;
  } catch {
    return EMPTY_SKILLS_CONFIG;
  }
}

export async function saveSkills(
  adapter: BrowserAdapter,
  config: SkillsConfig,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = SkillsConfig.safeParse(config);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      message: `${issue?.path.join('.') || 'skills'}: ${issue?.message ?? 'invalid'}`,
    };
  }
  await adapter.storageSet(SKILLS_STORAGE_KEY, parsed.data);
  return { ok: true };
}
