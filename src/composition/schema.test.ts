import { describe, it, expect } from 'vitest';
import {
  forkInputSchema,
  copyInputSchema,
  compositionInputSchema,
  extendInputSchema,
} from './schema';

describe('forkInputSchema', () => {
  it('should accept valid fork input', () => {
    const result = forkInputSchema.safeParse({
      authorId: '550e8400-e29b-41d4-a716-446655440000',
      authorType: 'human',
    });
    expect(result.success).toBe(true);
  });

  it('should accept bot author type', () => {
    const result = forkInputSchema.safeParse({
      authorId: '550e8400-e29b-41d4-a716-446655440000',
      authorType: 'bot',
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid author type', () => {
    const result = forkInputSchema.safeParse({
      authorId: '550e8400-e29b-41d4-a716-446655440000',
      authorType: 'org',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing authorId', () => {
    const result = forkInputSchema.safeParse({ authorType: 'human' });
    expect(result.success).toBe(false);
  });

  it('should reject non-UUID authorId', () => {
    const result = forkInputSchema.safeParse({
      authorId: 'not-a-uuid',
      authorType: 'human',
    });
    expect(result.success).toBe(false);
  });
});

describe('copyInputSchema', () => {
  it('should accept valid copy input', () => {
    const result = copyInputSchema.safeParse({
      authorId: '550e8400-e29b-41d4-a716-446655440000',
      authorType: 'human',
    });
    expect(result.success).toBe(true);
  });
});

describe('compositionInputSchema', () => {
  const validInput = {
    name: 'My Composition',
    description: 'A test composition for unit testing',
    authorId: '550e8400-e29b-41d4-a716-446655440000',
    authorType: 'human' as const,
    steps: [
      { skillId: '550e8400-e29b-41d4-a716-446655440001' },
      { skillId: '550e8400-e29b-41d4-a716-446655440002' },
    ],
  };

  it('should accept valid composition input', () => {
    const result = compositionInputSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('should accept composition with all step fields', () => {
    const result = compositionInputSchema.safeParse({
      ...validInput,
      slug: 'my-composition',
      tags: ['devtools', 'ci'],
      steps: [
        {
          skillId: '550e8400-e29b-41d4-a716-446655440001',
          stepName: 'Step 1',
          inputMapping: { input: 'previous.output' },
          onError: 'skip',
        },
        {
          skillId: '550e8400-e29b-41d4-a716-446655440002',
          stepName: 'Step 2',
          onError: 'retry',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('should reject fewer than 2 steps', () => {
    const result = compositionInputSchema.safeParse({
      ...validInput,
      steps: [{ skillId: '550e8400-e29b-41d4-a716-446655440001' }],
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing description', () => {
    const { description, ...noDesc } = validInput;
    const result = compositionInputSchema.safeParse(noDesc);
    expect(result.success).toBe(false);
  });

  it('should reject description shorter than 10 chars', () => {
    const result = compositionInputSchema.safeParse({
      ...validInput,
      description: 'Short',
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid onError value', () => {
    const result = compositionInputSchema.safeParse({
      ...validInput,
      steps: [
        { skillId: '550e8400-e29b-41d4-a716-446655440001', onError: 'explode' },
        { skillId: '550e8400-e29b-41d4-a716-446655440002' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid slug format', () => {
    const result = compositionInputSchema.safeParse({
      ...validInput,
      slug: 'Invalid Slug!',
    });
    expect(result.success).toBe(false);
  });
});

describe('extendInputSchema', () => {
  it('should accept valid extend input', () => {
    const result = extendInputSchema.safeParse({
      authorId: '550e8400-e29b-41d4-a716-446655440000',
      authorType: 'bot',
      steps: [{ skillId: '550e8400-e29b-41d4-a716-446655440001' }],
    });
    expect(result.success).toBe(true);
  });

  it('should reject empty steps', () => {
    const result = extendInputSchema.safeParse({
      authorId: '550e8400-e29b-41d4-a716-446655440000',
      authorType: 'human',
      steps: [],
    });
    expect(result.success).toBe(false);
  });
});
