export class ModelSelector {
  static estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
  }

  static shouldUseGPT(
    inputText: string, 
    useClaudePreference: boolean,
    threshold: number = 30000
  ): boolean {
    if (!useClaudePreference) return true;
    
    const estimatedTokens = this.estimateTokenCount(inputText);
    return estimatedTokens > threshold;
  }
}