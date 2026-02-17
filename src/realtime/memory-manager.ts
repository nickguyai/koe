import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import { ConfigManager } from '../config/config-manager';

export interface MemoryTerm {
  term: string;
  category: 'proper_noun' | 'technical' | 'acronym' | 'other';
  frequency: number;
  lastSeen: string;
}

export interface SpeakerVoiceProfile {
  speakerKey: string;
  label: string;
  frequency: number;
  lastSeen: string;
}

interface MemoryStore {
  terms: MemoryTerm[];
  speakerProfiles: SpeakerVoiceProfile[];
  version: number;
}

const MAX_TERMS = 1000;
const RECENCY_DECAY_DAYS = 30;

export class MemoryManager {
  private config: ConfigManager;
  private storePath: string;
  private store: MemoryStore;
  private client: OpenAI | null = null;
  private clientKey: string | null = null;

  constructor(config: ConfigManager) {
    this.config = config;
    this.storePath = path.join(app.getPath('userData'), 'vocabulary-memory.json');
    this.store = this.loadStore();
  }

  private loadStore(): MemoryStore {
    if (fs.existsSync(this.storePath)) {
      try {
        const raw = fs.readFileSync(this.storePath, 'utf-8');
        const data = JSON.parse(raw) as MemoryStore;
        if (Array.isArray(data.terms)) {
          return {
            terms: data.terms,
            speakerProfiles: Array.isArray(data.speakerProfiles) ? data.speakerProfiles : [],
            version: data.version || 1,
          };
        }
      } catch (err) {
        console.warn('Failed to load vocabulary memory:', err);
      }
    }
    return { terms: [], speakerProfiles: [], version: 1 };
  }

  private saveStore(): void {
    try {
      // Prune to max terms before saving
      if (this.store.terms.length > MAX_TERMS) {
        this.store.terms = this.getTopTerms(MAX_TERMS).map((term) => {
          const existing = this.store.terms.find((t) => t.term === term);
          return existing!;
        });
      }
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), 'utf-8');
    } catch (err) {
      console.warn('Failed to save vocabulary memory:', err);
    }
  }

  private getClient(): OpenAI {
    const apiKey = this.config.getApiKey('openai');
    if (!apiKey) {
      throw new Error('OpenAI API key is not set.');
    }
    if (!this.client || this.clientKey !== apiKey) {
      this.client = new OpenAI({ apiKey });
      this.clientKey = apiKey;
    }
    return this.client;
  }

  private calculateScore(term: MemoryTerm): number {
    const now = new Date();
    const lastSeen = new Date(term.lastSeen);
    const daysSinceLastSeen = (now.getTime() - lastSeen.getTime()) / (1000 * 60 * 60 * 24);
    const recencyFactor = Math.exp(-daysSinceLastSeen / RECENCY_DECAY_DAYS);
    return term.frequency * recencyFactor;
  }

  getTopTerms(n: number): string[] {
    const scored = this.store.terms.map((term) => ({
      term: term.term,
      score: this.calculateScore(term),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, n).map((s) => s.term);
  }

  getKnownSpeakerLabels(limit: number = 20): string[] {
    const fromMemory = this.store.speakerProfiles
      .slice()
      .sort((a, b) => {
        if (b.frequency !== a.frequency) {
          return b.frequency - a.frequency;
        }
        return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
      })
      .map((profile) => String(profile.label || '').trim())
      .filter(Boolean);

    const fromSettings = Object.values(this.config.getSettings().speakerLabels || {})
      .map((label) => String(label || '').trim())
      .filter(Boolean);

    return Array.from(new Set([...fromMemory, ...fromSettings])).slice(0, Math.max(1, limit));
  }

  syncSpeakerLabels(labels: Record<string, string>): void {
    if (!labels || typeof labels !== 'object') {
      return;
    }

    let changed = false;
    const now = new Date().toISOString();

    for (const [speakerKey, label] of Object.entries(labels)) {
      const key = this.normalizeSpeakerKey(speakerKey);
      const normalizedLabel = String(label || '').trim();
      if (!key || !normalizedLabel) {
        continue;
      }

      const existing = this.store.speakerProfiles.find((profile) => profile.speakerKey === key);
      if (existing) {
        if (existing.label !== normalizedLabel) {
          existing.label = normalizedLabel;
          existing.lastSeen = now;
          changed = true;
        }
      } else {
        this.store.speakerProfiles.push({
          speakerKey: key,
          label: normalizedLabel,
          frequency: 1,
          lastSeen: now,
        });
        changed = true;
      }
    }

    if (changed) {
      this.saveStore();
    }
  }

  rememberSpeakerLabel(speakerKey: string, label: string): void {
    const key = this.normalizeSpeakerKey(speakerKey);
    const normalizedLabel = String(label || '').trim();
    if (!key || !normalizedLabel) {
      return;
    }

    const now = new Date().toISOString();
    const existing = this.store.speakerProfiles.find((profile) => profile.speakerKey === key);
    if (existing) {
      existing.label = normalizedLabel;
      existing.frequency += 1;
      existing.lastSeen = now;
    } else {
      this.store.speakerProfiles.push({
        speakerKey: key,
        label: normalizedLabel,
        frequency: 1,
        lastSeen: now,
      });
    }

    this.saveStore();
  }

  rememberSpeakerLabels(labels: Record<string, string>): void {
    if (!labels || typeof labels !== 'object') {
      return;
    }
    for (const [speakerKey, label] of Object.entries(labels)) {
      this.rememberSpeakerLabel(speakerKey, label);
    }
  }

  getSpeakerLabel(speakerKey: string): string | null {
    const key = this.normalizeSpeakerKey(speakerKey);
    if (!key) {
      return null;
    }
    const profile = this.store.speakerProfiles.find((item) => item.speakerKey === key);
    if (profile?.label) {
      return profile.label;
    }
    return this.config.getSettings().speakerLabels?.[key] || null;
  }

  async updateFromTranscription(text: string): Promise<void> {
    const settings = this.config.getSettings();
    if (!settings.consensusMemoryEnabled) {
      return;
    }

    try {
      const terms = await this.extractTerms(text);
      const now = new Date().toISOString();

      for (const extracted of terms) {
        const existing = this.store.terms.find((t) => t.term.toLowerCase() === extracted.term.toLowerCase());
        if (existing) {
          existing.frequency += 1;
          existing.lastSeen = now;
          // Update category if more specific
          if (extracted.category !== 'other') {
            existing.category = extracted.category;
          }
        } else {
          this.store.terms.push({
            term: extracted.term,
            category: extracted.category,
            frequency: 1,
            lastSeen: now,
          });
        }
      }

      this.saveStore();
    } catch (err) {
      console.warn('Failed to update vocabulary from transcription:', err);
    }
  }

  private async extractTerms(text: string): Promise<Array<{ term: string; category: MemoryTerm['category'] }>> {
    if (!text.trim()) {
      return [];
    }

    const client = this.getClient();
    const prompt = `Extract important terms from the following text that would be useful to remember for future transcriptions. Focus on:
- Proper nouns (names of people, places, organizations, products)
- Technical terms and domain-specific vocabulary
- Acronyms and abbreviations

Return a JSON array of objects with "term" and "category" fields.
Category must be one of: "proper_noun", "technical", "acronym", "other"

Only include terms that are specific and would help improve future transcription accuracy.
Limit to the 20 most important terms.

Text:
${text.slice(0, 3000)}

Return only valid JSON array, no other text.`;

    try {
      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 500,
      });

      const content = response.choices[0]?.message?.content?.trim() || '[]';
      // Extract JSON array from response
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]) as Array<{ term: string; category: string }>;
      return parsed
        .filter((item) => item.term && typeof item.term === 'string')
        .map((item) => ({
          term: item.term.trim(),
          category: (['proper_noun', 'technical', 'acronym', 'other'].includes(item.category)
            ? item.category
            : 'other') as MemoryTerm['category'],
        }));
    } catch (err) {
      console.warn('Failed to extract terms:', err);
      return [];
    }
  }

  getTermCount(): number {
    return this.store.terms.length;
  }

  clearMemory(): void {
    this.store = { terms: [], speakerProfiles: [], version: 1 };
    this.saveStore();
  }

  private normalizeSpeakerKey(value: string): string {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }
}
