import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

interface LogEntry {
  timestamp: string;
  sessionId: string;
  platform: string;
  model: string;
  action: string;
  actionId: string;
  attempt: number;
  prompt: {
    strategy: string;
    length: number;
    content: string;
  };
  response: {
    success: boolean;
    error?: string;
    extractedData?: {
      ids: Record<string, string>;
      names: Record<string, string>;
      emails: string[];
      phones: string[];
      metadata: Record<string, any>;
    };
    agentOutput: string;
    analysisReason?: string;
  };
  tokens: {
    model: string;
    input: number;
    output: number;
    cost: number;
  };
  duration: number;
}

export class ExecutionLogger {
  private logDir: string;
  private currentLogFile: string;
  private sessionId: string;
  private totalCost: number = 0;
  private modelUsage: Map<string, { tokens: number; cost: number }> = new Map();

  constructor(platformName?: string) {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000; 
    const istTime = new Date(now.getTime() + istOffset);
    const timeStr = istTime.toISOString().replace(/:/g, '-').replace(/\..+/, '').replace('T', ' - ');
    
    if (!platformName) {
      throw new Error('Platform name is required for ExecutionLogger');
    }
    const safePlatformName = platformName.replace(/[^a-zA-Z0-9\s-]/g, '_');
    this.sessionId = `${safePlatformName} - ${timeStr}`; 
    
    this.logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.currentLogFile = path.join(this.logDir, `${this.sessionId}.json`);
    this.initializeLogFile();
  }

  private initializeLogFile(): void {
    const header = {
      sessionId: this.sessionId,
      startTime: new Date().toISOString(),
      entries: []
    };
    fs.writeFileSync(this.currentLogFile, JSON.stringify(header, null, 2));
  }

  logExecution(entry: Omit<LogEntry, 'timestamp' | 'sessionId'>): void {
    const fullEntry: LogEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId
    };

    this.totalCost += entry.tokens.cost;
    const modelKey = entry.tokens.model;
    const current = this.modelUsage.get(modelKey) || { tokens: 0, cost: 0 };
    this.modelUsage.set(modelKey, {
      tokens: current.tokens + entry.tokens.input + entry.tokens.output,
      cost: current.cost + entry.tokens.cost
    });

    const logData = JSON.parse(fs.readFileSync(this.currentLogFile, 'utf-8'));
    logData.entries.push(fullEntry);
    fs.writeFileSync(this.currentLogFile, JSON.stringify(logData, null, 2));
  }

  async logExecutionAsync(entry: Omit<LogEntry, 'timestamp' | 'sessionId'>): Promise<void> {
  const fullEntry: LogEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
    sessionId: this.sessionId
  };

  this.totalCost += entry.tokens.cost;
  const modelKey = entry.tokens.model;
  const current = this.modelUsage.get(modelKey) || { tokens: 0, cost: 0 };
  this.modelUsage.set(modelKey, {
    tokens: current.tokens + entry.tokens.input + entry.tokens.output,
    cost: current.cost + entry.tokens.cost
  });

  try {
    const logData = JSON.parse(await fs.promises.readFile(this.currentLogFile, 'utf-8'));
    logData.entries.push(fullEntry);
    await fs.promises.writeFile(this.currentLogFile, JSON.stringify(logData, null, 2));
  } catch (error) {
    console.error('Error writing to log file:', error);
  }
}

async generateSummaryReportAsync(): Promise<void> {
  try {
    const summaryContent = await this.buildSummaryContent();
    const summaryFile = path.join(this.logDir, `${this.sessionId}_summary.md`);
    await fs.promises.writeFile(summaryFile, summaryContent);
  } catch (error) {
    console.error('Error generating summary:', error);
  }
}

private async buildSummaryContent(): Promise<string> {
  const logData = JSON.parse(await fs.promises.readFile(this.currentLogFile, 'utf-8'));
  let summary = `# Execution Summary\n\n`;
  return summary;
}

  generateSummaryReport(): void {
    const summaryFile = path.join(this.logDir, `${this.sessionId}_summary.md`);
    let logData: { entries: LogEntry[], startTime?: string } = { entries: [] };
    let parsingError: string | null = null;

    try {
      if (fs.existsSync(this.currentLogFile)) {
          const fileContent = fs.readFileSync(this.currentLogFile, 'utf-8');
          if (fileContent) {
            logData = JSON.parse(fileContent);
          }
      }
    } catch (error: any) {
      console.error(chalk.yellow('Warning: Could not parse log file, it might be incomplete. Summary will be based on in-memory data.'), error.message);
      parsingError = error.message;
    }
    
    const entries = logData.entries || [];

    const toIST = (dateStr: string): string => {
      const date = new Date(dateStr);
      const istOffset = 5.5 * 60 * 60 * 1000;
      const istTime = new Date(date.getTime() + istOffset);
      return istTime.toISOString();
    };

    let summary = `# Execution Summary\n\n`;
    summary += `**Session ID:** ${this.sessionId}\n`;
    summary += `**Start Time (IST):** ${logData.startTime ? toIST(logData.startTime) : 'N/A'}\n`;
    summary += `**End Time (IST):** ${toIST(new Date().toISOString())}\n`;
    
    if (parsingError) {
      summary += `\n**⚠️ Warning:** The JSON log file was corrupted and could not be fully read. The summary may be incomplete. (Error: ${parsingError})\n`;
    }

    summary += `\n## Cost & Usage Summary\n`;
    summary += `**Total Estimated Cost:** $${this.totalCost.toFixed(4)}\n`;
    summary += `**Model Usage (In-Memory):**\n`;
    if (this.modelUsage.size > 0) {
      for (const [model, usage] of this.modelUsage.entries()) {
        summary += `- **${model}**: ${usage.tokens.toLocaleString()} tokens, $${usage.cost.toFixed(4)}\n`;
      }
    } else {
        summary += `- No model usage was recorded in memory.\n`
    }

    summary += `\n## Actions Summary \n\n`;
    const actionResults = new Map<string, { success: boolean; attempts: number }>();
for (const entry of entries) {
  const actionKey = `${entry.platform}:${entry.actionId}`;
  const existing = actionResults.get(actionKey);
  
  if (!existing) {
    actionResults.set(actionKey, {
      success: entry.response.success,
      attempts: 1
    });
  } else {
    existing.success = existing.success || entry.response.success;
    existing.attempts++;
  }
}

const platforms = new Map<string, { success: number; failed: number; totalAttempts: number }>();
for (const [actionKey, result] of actionResults.entries()) {
  const platform = actionKey.split(':')[0];
  const current = platforms.get(platform) || { success: 0, failed: 0, totalAttempts: 0 };
  
  if (result.success) {
    current.success++;
  } else {
    current.failed++;
  }
  current.totalAttempts += result.attempts;
  platforms.set(platform, current);
}

for (const [platform, stats] of platforms.entries()) {
  const total = stats.success + stats.failed;
  const rate = total > 0 ? ((stats.success / total) * 100).toFixed(1) : '0.0';
  summary += `### ${platform}\n`;
  summary += `- **Total Actions:** ${total}\n`;
  summary += `- **Success:** ${stats.success}\n`;
  summary += `- **Failed:** ${stats.failed}\n`;
  summary += `- **Success Rate:** ${rate}%\n`;
  summary += `- **Total Attempts:** ${stats.totalAttempts}\n\n`;
}

    fs.writeFileSync(summaryFile, summary);
    console.log(chalk.bold.green(`\n📊 Summary report generated: ${summaryFile}`));
  }


  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  calculateCost(model: 'claude-sonnet-4-20250514' | 'gpt-4.1' | 'gpt-4o', inputTokens: number, outputTokens: number): number {
    const pricing = {
  'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
  'gpt-4.1': { input: 0.002, output: 0.008 },  
  'gpt-4o': { input: 0.005, output: 0.015 }
};
    
    const modelPricing = pricing[model] || pricing['gpt-4.1'];
    return (inputTokens * modelPricing.input + outputTokens * modelPricing.output) / 1000;
  }
}