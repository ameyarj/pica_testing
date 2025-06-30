import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { LanguageModel } from "ai";

export function initializeModel(
  preferClaude: boolean, 
  componentName: string
): LanguageModel {
  if (preferClaude && process.env.ANTHROPIC_API_KEY) {
    try {
      return anthropic("claude-sonnet-4-20250514");
    } catch (error) {
      console.warn(`Failed to initialize Claude for ${componentName}, falling back to GPT-4.1`);
      return openai("gpt-4.1");
    }
  }
  return openai("gpt-4.1");
}
