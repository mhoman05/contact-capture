import { describe, expect, it } from 'vitest';
import { cleanEmail, cleanLinkedIn, cleanPhone, cleanWebsite, companyKey, sameName, similarName } from '../src/normalize';

describe('names', () => {
  it('matches regardless of accents, case, punctuation and order', () => {
    expect(sameName('Benedikt Rütter', 'benedikt rutter')).toBe(true);
    expect(sameName('Rütter, Benedikt', 'Benedikt Rütter')).toBe(true);
    expect(sameName('Álvaro Durán', 'Alvaro Duran')).toBe(true);
    expect(sameName('Carlos Fernández', 'Carlos Fernandez Herraiz')).toBe(false);
  });
  it('flags a name that is a subset of another as similar, never as the same', () => {
    expect(similarName('Álvaro Durán', 'Álvaro Durán Casares')).toBe(true);
    expect(similarName('Carlos Fernández', 'Carlos Fernandez Herraiz')).toBe(true);
    expect(similarName('Pablo', 'Pablo Campos')).toBe(false);
    expect(similarName('Abel Peña', 'Abel Castosa')).toBe(false);
    expect(similarName('Anna Lee', 'anna lee')).toBe(false);
  });
});

describe('companies', () => {
  it('ignores legal suffixes and punctuation', () => {
    expect(companyKey('BitGo, Inc.')).toBe(companyKey('Bitgo'));
    expect(companyKey('Euronext N.V.')).toBe('euronext n v');
    expect(companyKey('Iopa Solutions Ltd')).toBe('iopa solutions');
    expect(companyKey('Ltd')).toBe('ltd');
  });
});

describe('cleaning', () => {
  it('validates emails', () => {
    expect(cleanEmail(' Mailto:Mikel@Backpack.app ')).toBe('mikel@backpack.app');
    expect(cleanEmail('<jwenke@euronext.com>')).toBe('jwenke@euronext.com');
    expect(cleanEmail('not an email')).toBeNull();
    expect(cleanEmail(null)).toBeNull();
  });
  it('normalises LinkedIn profile URLs and rejects others', () => {
    expect(cleanLinkedIn('https://es.linkedin.com/in/Abel-Pe%C3%B1a-2098a85a/?trk=x')).toBe(
      'https://www.linkedin.com/in/abel-pe%C3%B1a-2098a85a',
    );
    expect(cleanLinkedIn('linkedin.com/in/jq818')).toBe('https://www.linkedin.com/in/jq818');
    expect(cleanLinkedIn('https://linkedin.com/company/bitgo')).toBeNull();
    expect(cleanLinkedIn('https://example.com/in/x')).toBeNull();
  });
  it('keeps plausible phone numbers only', () => {
    expect(cleanPhone('+49 174 9180720')).toBe('+49 174 9180720');
    expect(cleanPhone('0034 612 345 678')).toBe('+34 612 345 678');
    expect(cleanPhone('Tel: (917) 826-7405')).toBe('(917) 826-7405');
    expect(cleanPhone('12')).toBeNull();
  });
  it('turns bare domains into https URLs', () => {
    expect(cleanWebsite('www.bitgo.com')).toBe('https://www.bitgo.com');
    expect(cleanWebsite('https://backpack.app/')).toBe('https://backpack.app');
    expect(cleanWebsite('hello world')).toBeNull();
  });
});
