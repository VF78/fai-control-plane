import {readFile} from 'node:fs/promises';

const journalUrl = new URL('../drizzle/meta/_journal.json', import.meta.url);
const journal = JSON.parse(await readFile(journalUrl, 'utf8'));

const legacyTimestampDefect = new Map([
  [9, {tag: '0009_foundation', when: 1785040212085}],
  [10, {tag: '0010_foundation', when: 1785041565006}],
  [11, {tag: '0011_foundation', when: 1785043054907}],
  [12, {tag: '0012_foundation', when: 1785044512606}],
  [13, {tag: '0013_foundation', when: 1785049352095}],
  [14, {tag: '0014_foundation', when: 1785051468663}]
]);

let highWaterMark = Number.NEGATIVE_INFINITY;

for (const [position, entry] of journal.entries.entries()) {
  if (entry.idx !== position) {
    throw new Error(
      `Migration journal idx ${entry.idx} is out of sequence at position ${position}`
    );
  }

  if (!Number.isSafeInteger(entry.when)) {
    throw new Error(`Migration ${entry.tag} has an invalid timestamp`);
  }

  const legacyEntry = legacyTimestampDefect.get(entry.idx);

  if (legacyEntry) {
    if (entry.tag !== legacyEntry.tag || entry.when !== legacyEntry.when) {
      throw new Error(
        `Immutable legacy migration ${entry.idx} no longer matches its recorded defect`
      );
    }
  } else if (entry.when <= highWaterMark) {
    throw new Error(
      `Migration ${entry.tag} timestamp ${entry.when} must be greater than ${highWaterMark}`
    );
  }

  highWaterMark = Math.max(highWaterMark, entry.when);
}

console.log(`Validated ${journal.entries.length} migration journal entries`);
