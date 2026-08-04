import { describe, expect, it, vi } from 'vitest';
import { partitionStartResults, type CommunityHandle } from '../src/index.js';

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => noopLogger } as any;

function fakeHandle(name: string): CommunityHandle {
  return { name, relay: {} as any, store: {} as any, links: {} as any, bounties: {} as any };
}

describe('partitionStartResults', () => {
  it('returns every handle when all communities start successfully', () => {
    const results: PromiseSettledResult<CommunityHandle>[] = [
      { status: 'fulfilled', value: fakeHandle('a') },
      { status: 'fulfilled', value: fakeHandle('b') },
    ];

    const handles = partitionStartResults(results, ['a', 'b'], noopLogger);

    expect(handles.map((h) => h.name)).toEqual(['a', 'b']);
  });

  it('keeps the communities that started and logs (not throws) the ones that failed', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger } as any;
    const results: PromiseSettledResult<CommunityHandle>[] = [
      { status: 'fulfilled', value: fakeHandle('healthy') },
      { status: 'rejected', reason: new Error('connect ECONNREFUSED') },
    ];

    const handles = partitionStartResults(results, ['healthy', 'broken'], logger);

    expect(handles.map((h) => h.name)).toEqual(['healthy']);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ community: 'broken', err: expect.any(Error) }),
      expect.stringContaining('continuing with the communities that did'),
    );
  });

  it('returns an empty array when every community fails to start', () => {
    const results: PromiseSettledResult<CommunityHandle>[] = [
      { status: 'rejected', reason: new Error('one') },
      { status: 'rejected', reason: new Error('two') },
    ];

    const handles = partitionStartResults(results, ['a', 'b'], noopLogger);

    expect(handles).toEqual([]);
  });
});
