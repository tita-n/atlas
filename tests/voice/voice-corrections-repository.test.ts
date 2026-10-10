import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  openDatabase,
  type MemoryDatabase,
} from '../../src/memory/database.js';
import { VoiceCorrectionsRepository } from '../../src/memory/voice-corrections-repository.js';

function temporaryDatabasePath(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'atlas-voice-db-')).then((dir) =>
    join(dir, 'atlas.db'),
  );
}

describe('voice corrections repository', () => {
  let database: MemoryDatabase;
  let corrections: VoiceCorrectionsRepository;

  const setup = async (): Promise<void> => {
    database = openDatabase(await temporaryDatabasePath());
    corrections = new VoiceCorrectionsRepository(database);
  };

  const teardown = (): void => {
    database.close();
  };

  it('records a heard transcript', async () => {
    await setup();
    try {
      const id = corrections.create({ heardTranscript: 'show my disks' });
      expect(id).toBeGreaterThan(0);

      const entry = corrections.getById(id);
      expect(entry?.heardTranscript).toBe('show my disks');
      expect(entry?.correctedTranscript).toBeNull();
      expect(entry?.audioReference).toBe('');
    } finally {
      teardown();
    }
  });

  it('applies a correction to the latest uncorrected entry', async () => {
    await setup();
    try {
      const first = corrections.create({ heardTranscript: 'disk space' });
      const second = corrections.create({ heardTranscript: 'my space' });

      const target = corrections.latestUncorrected();
      expect(target?.id).toBe(second);

      expect(corrections.correct(second, 'memory space')).toBe(true);
      expect(corrections.getById(second)?.correctedTranscript).toBe(
        'memory space',
      );
      // The first entry is now the newest uncorrected one.
      expect(corrections.latestUncorrected()?.id).toBe(first);
    } finally {
      teardown();
    }
  });

  it('does not overwrite an existing correction', async () => {
    await setup();
    try {
      const id = corrections.create({ heardTranscript: 'x' });
      expect(corrections.correct(id, 'first')).toBe(true);
      expect(corrections.correct(id, 'second')).toBe(false);
      expect(corrections.getById(id)?.correctedTranscript).toBe('first');
    } finally {
      teardown();
    }
  });

  it('lists newest first and reports counts', async () => {
    await setup();
    try {
      corrections.create({ heardTranscript: 'one' });
      const two = corrections.create({ heardTranscript: 'two' });
      corrections.create({ heardTranscript: 'three' });
      corrections.correct(two, '2');

      const listed = corrections.list(10);
      expect(listed.map((entry) => entry.heardTranscript)).toEqual([
        'three',
        'two',
        'one',
      ]);
      expect(corrections.count()).toBe(3);
      expect(corrections.correctedCount()).toBe(1);
    } finally {
      teardown();
    }
  });

  it('honours the list limit', async () => {
    await setup();
    try {
      for (let index = 0; index < 5; index += 1) {
        corrections.create({ heardTranscript: `line ${index}` });
      }
      expect(corrections.list(2)).toHaveLength(2);
    } finally {
      teardown();
    }
  });

  it('stores an audio reference and a conversation id', async () => {
    await setup();
    try {
      const conversationId = corrections.create({ heardTranscript: 'a' });
      expect(conversationId).toBeGreaterThan(0);
      corrections.create({
        heardTranscript: 'b',
        audioReference: '/tmp/atlas-voice-audio/clip.wav',
      });
      const entry = corrections.latestUncorrected();
      expect(entry?.audioReference).toBe('/tmp/atlas-voice-audio/clip.wav');
    } finally {
      teardown();
    }
  });

  it('deletes an entry', async () => {
    await setup();
    try {
      const id = corrections.create({ heardTranscript: 'x' });
      expect(corrections.delete(id)).toBe(true);
      expect(corrections.getById(id)).toBeUndefined();
      expect(corrections.delete(id)).toBe(false);
    } finally {
      teardown();
    }
  });

  it('returns undefined for a missing entry', async () => {
    await setup();
    try {
      expect(corrections.getById(9999)).toBeUndefined();
      expect(corrections.latestUncorrected()).toBeUndefined();
    } finally {
      teardown();
    }
  });

  it('never stores raw audio inline', async () => {
    await setup();
    try {
      corrections.create({
        heardTranscript: 'hello',
        audioReference: '/path/to/clip.wav',
      });
      const row = database.connection
        .prepare('SELECT * FROM voice_corrections LIMIT 1')
        .get() as Record<string, unknown>;
      // Only the reference path is present; no blob/base64 column exists.
      expect(Object.keys(row).sort()).toEqual([
        'audio_reference',
        'conversation_id',
        'corrected_transcript',
        'heard_transcript',
        'id',
        'timestamp',
      ]);
    } finally {
      teardown();
    }
  });
});
