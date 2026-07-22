import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';

// The model seam: every model call in the app goes through a named role.
// Swapping or adding a model is an edit here, nowhere else. The transcription
// role is the XPRIZE Gemini qualifying call, wired via @ai-sdk/google
// (direct, not a gateway, to unambiguously go "through the Gemini API").
// The embedding model lives in ./embeddings.ts (its type is EmbeddingModel,
// not LanguageModel, and swapping it forces a corpus re-ingest — see there).
export type ModelRole = 'conversation' | 'summarizer' | 'transcription' | 'extraction' | 'planner';

const registry: Record<ModelRole, () => LanguageModel> = {
  conversation: () => anthropic('claude-sonnet-5'),
  summarizer: () => anthropic('claude-haiku-4-5-20251001'),
  transcription: () => google('gemini-3.5-flash'),
  // Vocab learning: pulls corrected terms out of (heard, sent) pairs. Same
  // model as summarizer today, but its own role — swapping one must never
  // silently change the other.
  extraction: () => anthropic('claude-haiku-4-5-20251001'),
  // generateObject call behind generate_plan: needs the same reasoning
  // quality as the conversation model, but kept as its own role — swapping
  // one must never silently change the other.
  planner: () => anthropic('claude-sonnet-5'),
};

export function getModel(role: ModelRole): LanguageModel {
  return registry[role]();
}
