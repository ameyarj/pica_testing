import { ConnectionDefinition } from '../interfaces/interface';
import chalk from 'chalk';

export interface FilteredPlatform {
  connection: ConnectionDefinition;
  originalIndex: number;
  displayIndex: number;
}

export class PlatformSelector {
 
  public static filterPlatforms(
    connections: ConnectionDefinition[], 
    searchTerm: string
  ): FilteredPlatform[] {
    if (!searchTerm || searchTerm.trim() === '') {
      return connections.map((conn, index) => ({
        connection: conn,
        originalIndex: index,
        displayIndex: index + 1
      }));
    }

    const keywords = searchTerm.toLowerCase().split(' ').filter(k => k.length > 0);
    
    const filtered = connections
      .map((conn, index) => ({ connection: conn, originalIndex: index }))
      .filter(({ connection }) => 
        keywords.every(keyword => 
          connection.name.toLowerCase().includes(keyword) || 
          connection.platform.toLowerCase().includes(keyword)
        )
      )
      .map((item, displayIndex) => ({
        ...item,
        displayIndex: displayIndex + 1
      }));

    return filtered;
  }
  public static displayFilteredResults(filteredPlatforms: FilteredPlatform[]): void {
    if (filteredPlatforms.length === 0) {
      console.log(chalk.red('No platforms found matching your search.'));
      return;
    }

    console.log(chalk.green(`\n✅ Found ${filteredPlatforms.length} matching platform${filteredPlatforms.length > 1 ? 's' : ''}:`));
    filteredPlatforms.forEach(({ connection, displayIndex }) => {
      console.log(`${chalk.cyan(String(displayIndex).padStart(2))}. ${chalk.bold(connection.name)} - ${connection.platform}`);
    });
  }
  public static displayAllPlatforms(connections: ConnectionDefinition[]): void {
    console.log(chalk.bold("\n🔗 Available Platforms for Testing:"));
    connections.forEach((conn, index) => {
      console.log(`${chalk.cyan(String(index + 1).padStart(3))}. ${chalk.bold(conn.name)} - ${conn.platform}`);
    });
  }

  public static isValidSelection(input: string, maxOptions: number): boolean {
    const num = parseInt(input.trim());
    return !isNaN(num) && num >= 1 && num <= maxOptions;
  }

  public static getConnectionByDisplayIndex(
    filteredPlatforms: FilteredPlatform[], 
    displayIndex: number
  ): ConnectionDefinition | null {
    const found = filteredPlatforms.find(fp => fp.displayIndex === displayIndex);
    return found ? found.connection : null;
  }
  public static showSelectionMenu(): void {
    console.log(chalk.bold.cyan('\n🔗 Platform Selection Options:'));
    console.log('1. Search for platform (filter by name)');
    console.log('2. Browse all platforms (traditional numeric selection)');
    console.log('3. Exit');
  }
  public static suggestSimilarPlatforms(
    connections: ConnectionDefinition[], 
    searchTerm: string
  ): FilteredPlatform[] {
    const keywords = searchTerm.toLowerCase().split(' ').filter(k => k.length > 0);
    
    const suggestions = connections
      .map((conn, index) => ({ connection: conn, originalIndex: index }))
      .filter(({ connection }) => 
        keywords.some(keyword => 
          connection.name.toLowerCase().includes(keyword) || 
          connection.platform.toLowerCase().includes(keyword)
        )
      )
      .map((item, displayIndex) => ({
        ...item,
        displayIndex: displayIndex + 1
      }));

    return suggestions.slice(0, 5);
  }
}
