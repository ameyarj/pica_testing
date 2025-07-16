import { ModelDefinition } from '../interfaces/interface';
import chalk from 'chalk';

export interface TokenActionConfig {
  tokenKeywords: string[];
  destructiveKeywords: string[];
  safeKeywords: string[];
  customSkipPatterns: RegExp[];
  platformSpecificRules: Record<string, {
    tokenKeywords?: string[];
    destructiveKeywords?: string[];
    safeKeywords?: string[];
  }>;
}

export interface TokenActionResult {
  shouldSkip: boolean;
  reason: string;
  category: 'token-destructive' | 'token-safe' | 'non-token';
  matchedKeywords: string[];
}

export class TokenActionDetector {
  private config: TokenActionConfig;

  constructor(config?: Partial<TokenActionConfig>) {
    this.config = {
      tokenKeywords: [
        'token', 'apikey', 'api key', 'access token', 'auth token', 
        'oauth token', 'bearer token', 'jwt token', 'session token',
        'refresh token', 'client secret', 'api secret', 'credential'
      ],
      destructiveKeywords: [
        'revoke', 'delete', 'remove', 'invalidate', 'destroy', 
        'expire', 'disable', 'cancel', 'terminate', 'withdraw'
      ],
      safeKeywords: [
        'get', 'retrieve', 'list', 'show', 'view', 'create', 
        'generate', 'refresh', 'renew', 'update', 'modify', 'edit'
      ],
      customSkipPatterns: [],
      platformSpecificRules: {},
      ...config
    };
  }

  public detectTokenAction(action: ModelDefinition): TokenActionResult {
    const actionName = action.actionName.toLowerCase();
    const actionTitle = action.title.toLowerCase();
    const actionPath = action.path?.toLowerCase() || '';
    const platform = action.connectionPlatform.toLowerCase();

    const platformRules = this.config.platformSpecificRules[platform] || {};
    const tokenKeywords = [...this.config.tokenKeywords, ...(platformRules.tokenKeywords || [])];
    const destructiveKeywords = [...this.config.destructiveKeywords, ...(platformRules.destructiveKeywords || [])];
    const safeKeywords = [...this.config.safeKeywords, ...(platformRules.safeKeywords || [])];

    for (const pattern of this.config.customSkipPatterns) {
      if (pattern.test(actionName) || pattern.test(actionTitle)) {
        return {
          shouldSkip: true,
          reason: 'Matches custom skip pattern',
          category: 'token-destructive',
          matchedKeywords: ['custom-pattern']
        };
      }
    }

    const matchedTokenKeywords = tokenKeywords.filter(keyword => 
      actionName.includes(keyword) || 
      actionTitle.includes(keyword) || 
      actionPath.includes(keyword)
    );

    if (matchedTokenKeywords.length === 0) {
      return {
        shouldSkip: false,
        reason: 'Not token-related',
        category: 'non-token',
        matchedKeywords: []
      };
    }

    const matchedSafeKeywords = safeKeywords.filter(keyword => 
      actionName.includes(keyword) || actionTitle.includes(keyword)
    );

    if (matchedSafeKeywords.length > 0) {
      return {
        shouldSkip: false,
        reason: `Safe token operation: ${matchedSafeKeywords.join(', ')}`,
        category: 'token-safe',
        matchedKeywords: [...matchedTokenKeywords, ...matchedSafeKeywords]
      };
    }

    const matchedDestructiveKeywords = destructiveKeywords.filter(keyword => 
      actionName.includes(keyword) || actionTitle.includes(keyword)
    );

    if (matchedDestructiveKeywords.length > 0) {
      return {
        shouldSkip: true,
        reason: `Destructive token operation: ${matchedDestructiveKeywords.join(', ')}`,
        category: 'token-destructive',
        matchedKeywords: [...matchedTokenKeywords, ...matchedDestructiveKeywords]
      };
    }

    return {
      shouldSkip: false,
      reason: 'Token-related but operation type unclear, allowing execution',
      category: 'token-safe',
      matchedKeywords: matchedTokenKeywords
    };
  }

  public shouldSkipAction(action: ModelDefinition): boolean {
    return this.detectTokenAction(action).shouldSkip;
  }

  public getSkipReason(action: ModelDefinition): string {
    return this.detectTokenAction(action).reason;
  }

  public updateConfig(newConfig: Partial<TokenActionConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  public addCustomSkipPattern(pattern: RegExp): void {
    this.config.customSkipPatterns.push(pattern);
  }

  public addPlatformRule(platform: string, rules: {
    tokenKeywords?: string[];
    destructiveKeywords?: string[];
    safeKeywords?: string[];
  }): void {
    this.config.platformSpecificRules[platform] = {
      ...this.config.platformSpecificRules[platform],
      ...rules
    };
  }

  public logDetectionResult(action: ModelDefinition, result: TokenActionResult): void {
    const icon = result.shouldSkip ? '🚫' : '✅';
    const color = result.shouldSkip ? chalk.yellow : chalk.gray;
    
    console.log(color(
      `   ${icon} Token Detection: ${action.title} - ${result.reason}`
    ));
    
    if (result.matchedKeywords.length > 0) {
      console.log(color(
        `      Keywords: ${result.matchedKeywords.join(', ')}`
      ));
    }
  }

  public getDetectionStats(): {
    totalChecked: number;
    skipped: number;
    allowed: number;
    categories: Record<string, number>;
  } {
    return {
      totalChecked: 0,
      skipped: 0,
      allowed: 0,
      categories: {}
    };
  }
}

export const defaultTokenDetector = new TokenActionDetector();

export function shouldSkipTokenAction(action: ModelDefinition): boolean {
  return defaultTokenDetector.shouldSkipAction(action);
}

export function getTokenActionSkipReason(action: ModelDefinition): string {
  return defaultTokenDetector.getSkipReason(action);
}
