export type L2StyleProfileField = "collocation" | "example";

export interface L2StyleProfile {
  id: string;
  version: string;
  label: string;
  fieldScope: L2StyleProfileField[];
  description?: string;
  promptRules: {
    register?: "neutral" | "academic" | "spoken" | "exam" | "literary" | "formal" | "informal";
    difficulty?: string;
    cefrRange?: string[];
    domains?: string[];
    sentenceLength?: "short" | "medium" | "long";
    includeTranslation?: boolean;
    includeUsageNote?: boolean;
    includePattern?: boolean;
    avoidRareWords?: boolean;
    avoidCliches?: boolean;
    examReady?: boolean;
    maxItems?: number;
  };
}

export const STYLE_PROFILES: L2StyleProfile[] = [
  { id: "default", version: "1.0", label: "通用", fieldScope: ["collocation","example"], promptRules: { includeTranslation: true, maxItems: 3 } },
  { id: "postgraduate_essay", version: "1.0", label: "考研写作", fieldScope: ["example"], description: "考研作文风格", promptRules: { register: "formal", difficulty: "考研", avoidCliches: true, includeTranslation: true, maxItems: 2 } },
  { id: "academic", version: "1.0", label: "学术", fieldScope: ["example"], promptRules: { register: "academic", difficulty: "academic", includeTranslation: true, maxItems: 2 } },
  { id: "daily_spoken", version: "1.0", label: "日常口语", fieldScope: ["example"], promptRules: { register: "informal", difficulty: "daily", includeTranslation: true, maxItems: 2 } },
  { id: "core_collocation", version: "1.0", label: "核心搭配", fieldScope: ["collocation"], promptRules: { maxItems: 3 } },
  { id: "exam_collocation", version: "1.0", label: "考试搭配", fieldScope: ["collocation"], promptRules: { examReady: true, maxItems: 3 } },
];

export function getStyleProfile(id?: string): L2StyleProfile {
  if (!id) return STYLE_PROFILES[0]; // default
  return STYLE_PROFILES.find(p => p.id === id) ?? STYLE_PROFILES[0];
}

export function findStyleProfile(id: string): L2StyleProfile | undefined {
  return STYLE_PROFILES.find(p => p.id === id);
}

export function validateStyleProfileField(profile: L2StyleProfile, field: L2StyleProfileField): void {
  if (!profile.fieldScope.includes(field)) {
    throw new Error(`Style profile "${profile.id}" does not support field "${field}"`);
  }
}
