export const SUBMITTED_REVIEW_PROFILE = 'github-submitted-review-v1';

export function validQodoIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)
    || !Number.isSafeInteger(identity.userId) || identity.userId < 1) return false;
  const keys = Object.keys(identity);
  if (keys.length === 1 && Object.hasOwn(identity, 'userId')) return true;
  return keys.length === 4
    && ['userId', 'appId', 'appSlug', 'completion'].every(key => Object.hasOwn(identity, key))
    && Number.isSafeInteger(identity.appId) && identity.appId > 0
    && identity.appSlug === 'qodo-code-review'
    && identity.completion === SUBMITTED_REVIEW_PROFILE;
}
