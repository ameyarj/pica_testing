export class EnhancedModelSelector {
  private static readonly TOKEN_THRESHOLDS = {
    CLAUDE_MAX_INPUT: 20000,
    PREFER_GPT_ABOVE: 15000,
    LARGE_CONTEXT: 10000
  };

  static selectModel(
    task: 'agent' | 'analysis' | 'refinement' | 'extraction' | 'dependency' | 'prompt',
    inputLength: number,
    hasClaude: boolean = true
  ): 'claude-sonnet-4-20250514' | 'gpt-4.1' | 'gpt-4o' {
    if (!hasClaude) return 'gpt-4.1';

    const estimatedTokens = Math.ceil(inputLength / 4);

    switch (task) {
      case 'agent':
        return estimatedTokens > this.TOKEN_THRESHOLDS.CLAUDE_MAX_INPUT ? 'gpt-4.1' : 'claude-sonnet-4-20250514';
      
      case 'analysis':
        return estimatedTokens > this.TOKEN_THRESHOLDS.LARGE_CONTEXT ? 'gpt-4.1' : 'claude-sonnet-4-20250514';
      
      case 'dependency':
        return estimatedTokens > this.TOKEN_THRESHOLDS.PREFER_GPT_ABOVE ? 'gpt-4.1' : 'claude-sonnet-4-20250514';
      
      case 'extraction':
        return estimatedTokens > this.TOKEN_THRESHOLDS.LARGE_CONTEXT ? 'gpt-4o' : 'claude-sonnet-4-20250514';
      
      case 'refinement':
      case 'prompt':
        return estimatedTokens > this.TOKEN_THRESHOLDS.CLAUDE_MAX_INPUT ? 'gpt-4.1' : 'claude-sonnet-4-20250514';
      
      default:
        return estimatedTokens > this.TOKEN_THRESHOLDS.PREFER_GPT_ABOVE ? 'gpt-4.1' : 'claude-sonnet-4-20250514';
    }
  }

  static shouldUseGPTForCost(estimatedTokens: number): boolean {
    return estimatedTokens > this.TOKEN_THRESHOLDS.PREFER_GPT_ABOVE;
  }
}