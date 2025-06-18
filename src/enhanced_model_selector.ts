import chalk from 'chalk';

export class EnhancedModelSelector {
  private static readonly TOKEN_THRESHOLDS = {
    CLAUDE_MAX_INPUT: 20000,
    PREFER_GPT_ABOVE: 15000,
    LARGE_CONTEXT: 10000,
    DEPENDENCY_FALLBACK: 8000
  };

  static selectModel(
    task: 'agent' | 'analysis' | 'refinement' | 'extraction' | 'dependency' | 'prompt',
    inputLength: number,
    hasClaude: boolean = true
  ): 'claude-sonnet-4-20250514' | 'gpt-4.1' | 'gpt-4o' {
    if (!hasClaude) {
      console.log(chalk.gray(`   (ModelSelector: Using gpt-4.1 as Claude is not available)`));
      return 'gpt-4.1';
    }

    const estimatedTokens = Math.ceil(inputLength / 4);

    switch (task) {
      case 'agent':
        if (estimatedTokens > this.TOKEN_THRESHOLDS.CLAUDE_MAX_INPUT) {
          console.log(chalk.gray(`   (ModelSelector: Switching to gpt-4.1 for ${task} due to token limit: ~${estimatedTokens} tokens)`));
          return 'gpt-4.1';
        }
        return 'claude-sonnet-4-20250514';
      
      case 'analysis':
        if (estimatedTokens > this.TOKEN_THRESHOLDS.LARGE_CONTEXT) {
          console.log(chalk.gray(`   (ModelSelector: Switching to gpt-4.1 for ${task} due to large context: ~${estimatedTokens} tokens)`));
          return 'gpt-4.1';
        }
        return 'claude-sonnet-4-20250514';
      
      case 'dependency':
        if (estimatedTokens > this.TOKEN_THRESHOLDS.DEPENDENCY_FALLBACK) {
          console.log(chalk.gray(`   (ModelSelector: Token limit approaching, using fallback analysis)`));
          return 'gpt-4.1'; 
        }
        return 'claude-sonnet-4-20250514';
      
      case 'extraction':
        if (estimatedTokens > this.TOKEN_THRESHOLDS.LARGE_CONTEXT) {
          console.log(chalk.gray(`   (ModelSelector: Switching to gpt-4o for ${task} due to large input: ~${estimatedTokens} tokens)`));
          return 'gpt-4o';
        }
        return 'claude-sonnet-4-20250514';
      
      case 'refinement':
      case 'prompt':
        if (estimatedTokens > this.TOKEN_THRESHOLDS.CLAUDE_MAX_INPUT) {
          console.log(chalk.gray(`   (ModelSelector: Switching to gpt-4.1 for ${task} due to token limit: ~${estimatedTokens} tokens)`));
          return 'gpt-4.1';
        }
        return 'claude-sonnet-4-20250514';
      
      default:
        if (estimatedTokens > this.TOKEN_THRESHOLDS.PREFER_GPT_ABOVE) {
          console.log(chalk.gray(`   (ModelSelector: Switching to gpt-4.1 for ${task} due to default threshold: ~${estimatedTokens} tokens)`));
          return 'gpt-4.1';
        }
        return 'claude-sonnet-4-20250514';
    }
  }
}