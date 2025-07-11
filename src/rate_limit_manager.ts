import chalk from 'chalk';
import readline from 'readline/promises';

interface RateLimitInfo {
  hitTime: number;
  retryAfter?: number;
  platform: string;
  endpoint?: string;
}

export class RateLimitManager {
  private lastRateLimit: RateLimitInfo | null = null;

  constructor() {
  }

  isRateLimitError(error: string, output?: string): boolean {
    const errorText = (error + ' ' + (output || '')).toLowerCase();
    
    return errorText.includes('429') || 
           errorText.includes('rate limit') ||
           errorText.includes('too many requests') ||
           errorText.includes('quota exceeded') ||
           errorText.includes('rate exceeded');
  }

  extractRetryAfter(error: string, output?: string): number | undefined {
    const fullText = error + ' ' + (output || '');
    
    const retryAfterMatch = fullText.match(/retry[-_]after[:\s]*(\d+)/i);
    if (retryAfterMatch) {
      return parseInt(retryAfterMatch[1]);
    }

    const timeMatch = fullText.match(/try again in (\d+)\s*(second|minute|hour)s?/i);
    if (timeMatch) {
      const value = parseInt(timeMatch[1]);
      const unit = timeMatch[2].toLowerCase();
      
      switch (unit) {
        case 'second': return value;
        case 'minute': return value * 60;
        case 'hour': return value * 3600;
        default: return value;
      }
    }

    return 240; 
  }

  async handleRateLimit(
    platform: string, 
    error: string, 
    output?: string,
    endpoint?: string
  ): Promise<'retry' | 'abort'> {
    const retryAfter = this.extractRetryAfter(error, output);
    
    this.lastRateLimit = {
      hitTime: Date.now(),
      retryAfter,
      platform,
      endpoint
    };

    console.log(chalk.red.bold('\n⚠️  RATE LIMIT DETECTED ⚠️'));
    console.log(chalk.yellow(`Platform: ${platform}`));
    if (endpoint) {
      console.log(chalk.yellow(`Endpoint: ${endpoint}`));
    }
    console.log(chalk.yellow(`Error: ${error}`));
    
    if (retryAfter) {
      console.log(chalk.cyan(`\n🕐 Suggested wait time: ${this.formatDuration(retryAfter * 1000)}`));
    }

    console.log(chalk.bold.cyan('\n📋 Rate Limit Options:'));
    console.log('1. Wait and retry automatically');
    console.log('2. Wait manually (you control when to continue)');
    console.log('3. Abort current execution');
    console.log(chalk.gray('(Auto-selecting option 1 in 30 seconds for server environments)'));

    const choice = await this.getUserChoiceWithTimeout();
    
    switch (choice) {
      case '1':
        if (retryAfter) {
          await this.automaticWait(retryAfter);
          return 'retry';
        } else {
          console.log(chalk.yellow('No retry time available. Using default 4-minute wait...'));
          await this.automaticWait(240); 
          return 'retry';
        }
        
      case '2':
        await this.manualWait();
        return 'retry';
        
      case '3':
        console.log(chalk.yellow('User chose to abort execution.'));
        return 'abort';
        
      default:
        console.log(chalk.blue('\n⏰ Auto-selected option 1 for server environment'));
        if (retryAfter) {
          await this.automaticWait(retryAfter);
        } else {
          await this.automaticWait(240); 
        }
        return 'retry';
    }
  }

  private async getUserChoiceWithTimeout(): Promise<string> {
    const timeoutMs = 30000; // 30 seconds timeout
    
    return new Promise<string>((resolve) => {
      let timeoutId: NodeJS.Timeout;
      let rl: readline.Interface | null = null;
      let isResolved = false;

      timeoutId = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          if (rl) {
            rl.close();
          }
          resolve('auto'); 
        }
      }, timeoutMs);

      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const askQuestion = async () => {
        try {
          while (!isResolved) {
            const choice = await rl!.question('\n➡️ Choose option (1-3): ');
            
            const cleanChoice = choice.trim().charAt(0);
            
            if (['1', '2', '3'].includes(cleanChoice)) {
              isResolved = true;
              clearTimeout(timeoutId);
              rl!.close();
              resolve(cleanChoice);
              return;
            } else {
              console.log(chalk.red('Invalid choice. Please select 1, 2, or 3.'));
            }
          }
        } catch (error) {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            if (rl) {
              rl.close();
            }
            resolve('auto'); 
          }
        }
      };

      askQuestion();
    });
  }

  private async automaticWait(seconds: number): Promise<void> {
    console.log(chalk.blue(`\n⏳ Waiting ${this.formatDuration(seconds * 1000)} for rate limit to reset...`));
    console.log(chalk.gray('Press Ctrl+C if you want to interrupt and save state.'));
    
    let remaining = seconds;
    
    while (remaining > 0) {
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      
      process.stdout.write(`\r${chalk.cyan(`⏳ Time remaining: ${timeStr}`)}`);
      
      await this.sleep(1000);
      remaining--;
    }
    
    console.log(chalk.green('\n✅ Wait complete! Resuming execution...'));
  }
  private async manualWait(): Promise<void> {
    console.log(chalk.blue('\n⏸️  Execution paused due to rate limit.'));
    console.log(chalk.yellow('Please wait for the rate limit to reset, then continue.'));
    console.log(chalk.gray('You can check the API documentation or wait a few minutes.'));
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    try {
      while (true) {
        const response = await rl.question('\n➡️ Ready to continue? (y/n): ');
        
        if (response.toLowerCase() === 'y' || response.toLowerCase() === 'yes') {
          console.log(chalk.green('✅ Resuming execution...'));
          break;
        } else if (response.toLowerCase() === 'n' || response.toLowerCase() === 'no') {
          console.log(chalk.gray('⏸️  Still waiting... Take your time.'));
        } else {
          console.log(chalk.yellow('Please answer "y" for yes or "n" to continue waiting.'));
        }
      }
    } finally {
      rl.close();
    }
  }


  shouldPreventiveWait(platform: string): number {
    if (!this.lastRateLimit || this.lastRateLimit.platform !== platform) {
      return 0;
    }

    const timeSinceRateLimit = Date.now() - this.lastRateLimit.hitTime;
    const minWaitTime = (this.lastRateLimit.retryAfter || 60) * 1000;
    
    if (timeSinceRateLimit < minWaitTime) {
      return Math.ceil((minWaitTime - timeSinceRateLimit) / 1000);
    }
    
    return 0;
  }

  async preventiveWait(platform: string): Promise<void> {
    const waitSeconds = this.shouldPreventiveWait(platform);
    
    if (waitSeconds > 0) {
      console.log(chalk.yellow(`\n⏳ Preventive wait for ${platform}: ${this.formatDuration(waitSeconds * 1000)}`));
      await this.automaticWait(waitSeconds);
    }
  }

  getRateLimitStatus(): string | null {
    if (!this.lastRateLimit) return null;
    
    const timeSince = Date.now() - this.lastRateLimit.hitTime;
    const suggested = (this.lastRateLimit.retryAfter || 60) * 1000;
    
    if (timeSince < suggested) {
      const remaining = Math.ceil((suggested - timeSince) / 1000);
      return `Rate limit active for ${this.lastRateLimit.platform} (${this.formatDuration(remaining * 1000)} remaining)`;
    }
    
    return null;
  }

  clearRateLimitHistory(): void {
    this.lastRateLimit = null;
  }


  close(): void {

  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}
