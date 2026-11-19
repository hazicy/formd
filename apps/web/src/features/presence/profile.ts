import {
  createGuestUser,
  validPresenceUser,
  type PresenceUser,
} from '@formd/client';

export function loadProfile(): PresenceUser {
  try {
    const saved = JSON.parse(
      localStorage.getItem('formd.profile') ??
        localStorage.getItem('typo.profile') ??
        'null',
    );
    if (validPresenceUser(saved)) return { ...saved, client: 'web' };
  } catch {
    /* anonymous defaults */
  }
  const guest = createGuestUser('web');
  saveProfile(guest);
  return guest;
}

export function saveProfile(profile: PresenceUser) {
  try {
    localStorage.setItem('formd.profile', JSON.stringify(profile));
  } catch {
    /* private browsing */
  }
}
