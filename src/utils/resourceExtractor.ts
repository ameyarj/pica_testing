export const HTTP_ACTION_VERBS = [
  'create', 'get', 'update', 'delete', 'patch', 'put', 'post',
  'retrieve', 'list', 'fetch', 'remove', 'modify', 'add', 'insert',
  'search', 'query', 'find', 'read', 'write', 'edit', 'replace'
];

export function extractResourceFromTitle(title: string): string {
  let resourceName = title.toLowerCase();
  
  const words = resourceName.split(/\s+/);
  if (words.length > 0 && HTTP_ACTION_VERBS.includes(words[0])) {
    words.shift();
  }
  
  const modifiers = ['new', 'existing', 'specific', 'all', 'single', 'multiple'];
  const filteredWords = words.filter(word => !modifiers.includes(word));
  
  resourceName = filteredWords.join(' ').trim();
  
  if (resourceName === '' || resourceName === 'a' || resourceName === 'the') {
    if (title.toLowerCase().includes('time')) return 'time schedule';
    if (title.toLowerCase().includes('project')) return 'project';
    if (title.toLowerCase().includes('user')) return 'user';
    if (title.toLowerCase().includes('issue')) return 'issue';
    if (title.toLowerCase().includes('task')) return 'task';
    return 'resource';
  }
  
  return resourceName;
}