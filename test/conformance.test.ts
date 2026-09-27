import { describe, it } from 'vitest';
import { railConformance } from 'tollstile/testing';
import { harness } from './harness.js';

// Tollstile's own rail contract (tollstile/testing), unmodified.
describe('nano rail conformance', () => {
  for (const test of railConformance(harness)) (test.skip === undefined ? it : it.skip)(test.name, () => test.run());
});
