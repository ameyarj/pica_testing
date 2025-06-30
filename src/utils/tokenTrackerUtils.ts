import { tokenTracker } from '../global_token_tracker';

export async function trackLLMCall<T>(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  component: string,
  operation: string,
  llmCall: () => Promise<{ result: T; outputText: string }>
): Promise<T> {
  const inputTokens = tokenTracker.estimateTokens(systemPrompt + userPrompt);
  
  const { result, outputText } = await llmCall();
  
  const outputTokens = tokenTracker.estimateTokens(outputText);
  tokenTracker.trackUsage(model, inputTokens, outputTokens, component, operation);
  
  return result;
}