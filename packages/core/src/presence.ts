export const PRESENCE_COLORS = [
  '#527a56',
  '#b45e46',
  '#537fba',
  '#9864b0',
  '#a57924',
  '#268b87',
] as const;
export interface PresenceUser {
  name: string;
  color: string;
  client: 'web' | 'vscode' | 'mobile' | 'agent' | 'unknown';
}
export interface RelativeSelection {
  anchor: string;
  head: string;
}
export interface PresenceMember {
  id: string;
  user: PresenceUser;
  selection: RelativeSelection | null;
  agentFlash?: { id: string; range: RelativeSelection };
}
export function createGuestUser(
  client: PresenceUser['client'] = 'unknown',
  seed = Math.floor(Math.random() * 0xffffff),
): PresenceUser {
  return {
    name: `${client === 'vscode' ? 'VS Code ' : client === 'mobile' ? '手机 ' : ''}访客-${seed.toString(16).slice(-4).toUpperCase()}`,
    color: PRESENCE_COLORS[seed % PRESENCE_COLORS.length],
    client,
  };
}
export function validPresenceUser(value: unknown): value is PresenceUser {
  if (!value || typeof value !== 'object') return false;
  const user = value as Record<string, unknown>;
  return (
    typeof user.name === 'string' &&
    user.name.trim().length > 0 &&
    user.name.length <= 48 &&
    typeof user.color === 'string' &&
    /^#[0-9a-fA-F]{6}$/.test(user.color) &&
    ['web', 'vscode', 'mobile', 'agent', 'unknown'].includes(
      String(user.client),
    )
  );
}
export function validRelativeSelection(
  value: unknown,
): value is RelativeSelection | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const selection = value as Record<string, unknown>;
  return ['anchor', 'head'].every(
    (key) =>
      typeof selection[key] === 'string' &&
      (selection[key] as string).length > 0 &&
      (selection[key] as string).length <= 512 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(selection[key] as string),
  );
}
