import assert from 'node:assert/strict';
import test from 'node:test';
import { createTranscriptText } from '../src/services/transcriptExport';
import { sampleConversation } from '../src/demo/sampleConversation';

test('merges both directions chronologically without mutating the panels', () => {
  const messages = [sampleConversation[3], sampleConversation[0], sampleConversation[1]];
  const originalOrder = messages.map(message => message.id);
  const result = createTranscriptText(messages);
  assert.ok(result.indexOf(messages[1].original) < result.indexOf(messages[2].original));
  assert.ok(result.indexOf(messages[2].original) < result.indexOf(messages[0].original));
  assert.deepEqual(messages.map(message => message.id), originalOrder);
  assert.match(result, /English → 中文/);
  assert.match(result, /中文 → English/);
});

test('preserves the original when a corrected transcript exists', () => {
  const result = createTranscriptText([{ ...sampleConversation[0], original: 'Friday release', corrected: 'Friday’s release' }]);
  assert.match(result, /Original: Friday release/);
  assert.match(result, /Corrected: Friday’s release/);
});

test('labels partial translations and handles an empty translation', () => {
  const result = createTranscriptText([{ ...sampleConversation[0], translated: '', isTranslating: true }]);
  assert.match(result, /Translation \(in progress\): —/);
});

test('labels sample exports so they cannot be confused with live results', () => {
  assert.match(createTranscriptText(sampleConversation, { demo: true }), /fictional sample transcript/);
  assert.match(createTranscriptText([]), /No transcript entries/);
});

test('keeps entries with matching IDs from different language panels', () => {
  const result = createTranscriptText([sampleConversation[0], { ...sampleConversation[1], id: sampleConversation[0].id }]);
  assert.ok(result.includes(sampleConversation[0].original));
  assert.ok(result.includes(sampleConversation[1].original));
});
