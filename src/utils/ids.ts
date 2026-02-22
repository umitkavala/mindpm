import { randomBytes } from 'crypto';

export function generateId(): string {
  return randomBytes(4).toString('hex');
}

export function generateSlug(name: string): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const words = normalized.split(/\s+/).filter(Boolean);

  let slug: string;
  if (words.length > 1) {
    // Multi-word: first letter of each word, up to 4
    slug = words.slice(0, 4).map(w => w[0]).join('');
  } else {
    // Single word: strip vowels for a compact slug
    const consonants = normalized.replace(/[aeiou]/g, '');
    slug = consonants.length >= 2 ? consonants.slice(0, 4) : normalized.slice(0, 4);
  }

  return slug || normalized.slice(0, 4) || 'prj';
}
