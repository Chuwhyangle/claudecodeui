import assert from 'node:assert/strict';

import { test } from 'vitest';

import { OLDER_MESSAGES_PAGE_SIZE, OLDER_PAGE_PREFETCH_VIEWPORTS, planOlderPagePrefetch, SESSION_MESSAGES_PAGE_SIZE } from '@/modules/chat/utils/session/sessionMessagePagination';

// The upward path asks for an older page once the viewport is within a couple of screens of the
// top, not once it has reached the edge (the absolute `scrollTop < 100` this replaced), and holds
// a second request for the same arrival until the prepend's anchor restore moves the viewport back
// down. These are the two properties the browser criterion drives; here they are read directly, so
// a change to either fails without a browser.

test('the prefetch trigger distance is measured in viewport heights, not pixels', () => {
  const band = OLDER_PAGE_PREFETCH_VIEWPORTS * 400;
  assert.equal(
    planOlderPagePrefetch({ scrollTop: band, clientHeight: 400, armedAtScrollTop: null }),
    'trigger',
    'a viewport exactly at the band is still inside it',
  );
  assert.equal(
    planOlderPagePrefetch({ scrollTop: band + 1, clientHeight: 400, armedAtScrollTop: null }),
    'release',
    'one pixel past the band is out of it',
  );
});

test('a taller pane arms the prefetch proportionally earlier', () => {
  // Same scroll position, two pane heights: the short pane is nowhere near its top, the tall one
  // is already inside its band. A pixel threshold would answer these two the same way.
  assert.equal(
    planOlderPagePrefetch({ scrollTop: 1_500, clientHeight: 400, armedAtScrollTop: null }),
    'release',
  );
  assert.equal(
    planOlderPagePrefetch({ scrollTop: 1_500, clientHeight: 1_000, armedAtScrollTop: null }),
    'trigger',
  );
});

test('the prefetch is armed well before the viewport reaches the top edge', () => {
  // scrollTop 900 is many screens below the old `scrollTop < 100` edge yet inside a 900px pane's
  // band, which is the whole point: the page is asked for before the blank above the rows is on
  // screen.
  assert.equal(
    planOlderPagePrefetch({ scrollTop: 900, clientHeight: 900, armedAtScrollTop: null }),
    'trigger',
  );
});

test('a fetch already armed is held until the anchor restore moves the viewport back down', () => {
  const armedAt = 1_600;
  // The same arrival, and a wheel that carried the user further up: both hold rather than ask
  // again for the page that is already on its way.
  assert.equal(
    planOlderPagePrefetch({ scrollTop: armedAt, clientHeight: 800, armedAtScrollTop: armedAt }),
    'hold',
  );
  assert.equal(
    planOlderPagePrefetch({ scrollTop: armedAt - 400, clientHeight: 800, armedAtScrollTop: armedAt }),
    'hold',
  );
  // The prepend's restore adds the prepended height, so the viewport comes to rest *below* where
  // the fetch was armed — that is the release, and the next gesture up arms again.
  assert.equal(
    planOlderPagePrefetch({ scrollTop: armedAt + 3_000, clientHeight: 800, armedAtScrollTop: armedAt }),
    'release',
  );
  assert.equal(
    planOlderPagePrefetch({ scrollTop: 1_000, clientHeight: 800, armedAtScrollTop: null }),
    'trigger',
    'once released, the next entry into the band triggers',
  );
});

test('an older page is at least the criterion floor and leaves the latest page alone', () => {
  assert.ok(
    OLDER_MESSAGES_PAGE_SIZE >= 50,
    `the older-page size must be at least 50, was ${OLDER_MESSAGES_PAGE_SIZE}`,
  );
  assert.equal(
    SESSION_MESSAGES_PAGE_SIZE,
    20,
    'the latest/first page keeps its own size; AC-110 pins the first screen to it',
  );
});
